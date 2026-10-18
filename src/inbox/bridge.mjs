import { authenticated } from '../integrations/primitive/authentication.mjs';
import { authenticatedCustomer } from '../integrations/primitive/customer.mjs';
import { sha } from '../shared/crypto.mjs';
import { Rejected, Retry } from '../shared/errors.mjs';
import { requireThat, actionMetadata } from '../shared/validation.mjs';
import {
  hydrateEvent,
  loadCustomerAttachments,
  materializeAttachments,
} from './attachments.mjs';
import { validateDraftAttachments } from '../shared/attachments.mjs';
import { sentinelDecision } from '../shared/sentinel.mjs';

function validateProposal(event, proposal) {
  actionMetadata(proposal);
  validateDraftAttachments(proposal.attachments);
  validateDraftAttachments(proposal.evidence);
  sentinelDecision(proposal.sentinel);
  requireThat(
    event.kind === 'customer' ||
      ['changes_requested', 'answered'].includes(event.receipt.status),
    'proposal_after_terminal_receipt',
  );
  requireThat(
    typeof proposal.request_id === 'string' &&
      /^[a-f0-9-]{36}$/.test(proposal.request_id),
    'invalid_agent_request',
  );
  requireThat(
    typeof proposal.subject === 'string' &&
      proposal.subject.length <= 250 &&
      !/[\r\n\x00]/.test(proposal.subject) &&
      typeof proposal.body_text === 'string' &&
      proposal.body_text.trim() &&
      new TextEncoder().encode(proposal.body_text).length <= 24_000,
    'invalid_agent_draft',
  );
}

export class InboxBridge {
  constructor({ api, store, mail, invoke, config }) {
    this.api = api;
    this.store = store;
    this.mail = mail;
    this.invoke = invoke;
    this.config = config;
  }

  async read(key) {
    return (await this.store.get(key))?.value || null;
  }

  async write(key, value) {
    await this.store.put(key, compactForMemory(value));
  }

  async saveIfAbsent(key, value) {
    try {
      await this.store.put(key, compactForMemory(value), { if_absent: true });
      return value;
    } catch (error) {
      if (error.status !== 409) throw error;
      return this.read(key);
    }
  }

  async receive(email) {
    if (
      email.parsed?.status !== 'complete' ||
      !['accepted', 'completed'].includes(email.status)
    ) {
      throw new Retry('email_not_ready');
    }

    const checkpointKey = 'event/' + email.id;
    const checkpoint = await this.read(checkpointKey);

    if (checkpoint?.complete) {
      const { event, result, ...summary } = checkpoint;
      return { ...summary, replayed: true };
    }

    let event = checkpoint?.event;
    if (!event) {
      event =
        email.recipient === this.config.customer_sender
          ? await this.createCustomerEvent(email)
          : await this.createReceiptEvent(email);

      if (!event) {
        return { complete: true, status: 'ignored_unknown_receipt' };
      }

      const saved = await this.saveIfAbsent(checkpointKey, {
        event,
        complete: false,
      });
      event = saved.event;
    }

    // Save the model result before sending mail. A retry can reuse the same
    // proposal instead of asking the model to create a different one.
    const result =
      checkpoint?.result ||
      (await this.invoke(await hydrateEvent(event, this)));
    requireThat(
      result.conversation_id === event.conversation_id,
      'wrong_agent_conversation',
    );
    await this.write(checkpointKey, { event, result, complete: false });

    const permissionId = await this.requestApproval(event, result);
    await this.processDeferredEmails(
      event.conversation_id,
      result.deferred_emails || [],
    );

    const response = {
      complete: true,
      status: result.status,
      event_id: email.id,
      conversation_id: event.conversation_id,
      session_id: result.session_id,
      resumed: result.resumed,
      permission_id: permissionId,
      tool_calls: result.tool_calls,
      cost_usd: result.cost_usd,
      gateway_decisions: result.gateway_decisions,
    };

    await this.write(checkpointKey, { ...response, event, result });
    return response;
  }

  async createCustomerEvent(email) {
    const config = this.config;
    requireThat(authenticatedCustomer(email, config), 'untrusted_customer');
    requireThat(
      typeof email.parsed.body_text === 'string' &&
        email.parsed.body_text.length <= 24_000,
      'invalid_customer_message',
    );

    const previousSend = email.reply_to_sent_email_id
      ? await this.read('sent/' + email.reply_to_sent_email_id)
      : null;
    const conversationId =
      previousSend?.conversation_id || email.thread_id || email.id;
    requireThat(
      /^[-a-zA-Z0-9]{1,80}$/.test(conversationId),
      'invalid_thread_id',
    );
    const previousCustomer = await this.read('customer/' + conversationId);
    requireThat(
      !previousCustomer ||
        previousCustomer.from_email === email.from_email.toLowerCase(),
      'conversation_customer_mismatch',
    );

    const event = {
      id: email.id,
      kind: 'customer',
      conversation_id: conversationId,
      email: {
        id: email.id,
        from_email: email.from_email.toLowerCase(),
        message_id: email.message_id,
        subject: email.subject,
        body_text: email.parsed.body_text,
        attachments: await loadCustomerAttachments(email, this.mail),
      },
    };

    await this.write('customer/' + conversationId, event.email);
    return event;
  }

  async createReceiptEvent(email) {
    const config = this.config;
    requireThat(email.recipient === config.requester_address, 'wrong_inbox');
    requireThat(
      authenticated(email, config.approval_address, config),
      'untrusted_receipt',
    );

    let receipt;
    try {
      receipt = JSON.parse(email.parsed.body_text);
    } catch {
      throw new Rejected('invalid_receipt_json');
    }

    requireThat(
      ['permission.receipt/1', 'question.receipt/1'].includes(
        receipt.protocol,
      ) && /^[A-F0-9]{16}$/.test(receipt.request_id || ''),
      'invalid_receipt',
    );

    const context = await this.read('request/' + receipt.request_id);
    if (!context) return null;
    requireThat(
      context.client_request_id === receipt.client_request_id,
      'wrong_receipt_request',
    );
    requireThat(
      receipt.protocol === (context.receipt_protocol || 'permission.receipt/1'),
      'wrong_receipt_kind',
    );
    requireThat(
      receipt.status !== 'answered' ||
        receipt.protocol === 'question.receipt/1',
      'invalid_answer_receipt',
    );

    // Remember which conversation a customer reply to the delivered email
    // belongs to, even if the provider gives that reply a new thread ID.
    if (receipt.status === 'executed' && receipt.execution?.provider_id) {
      await this.write('sent/' + receipt.execution.provider_id, {
        conversation_id: context.conversation_id,
      });
    }

    return {
      id: email.id,
      kind: 'receipt',
      conversation_id: context.conversation_id,
      ...(context.customer_email ? { email: context.customer_email } : {}),
      receipt,
    };
  }

  async processDeferredEmails(conversationId, emails) {
    for (const email of emails) {
      // Restore message_id as well as attachment bytes before dispatching,
      // so a queued reply retains its original email threading.
      const event = await hydrateEvent(
        {
          id: email.id + '-deferred',
          kind: 'customer',
          conversation_id: conversationId,
          email,
        },
        this,
      );

      const result = await this.invoke(event);
      await this.requestApproval(event, result);
    }
  }

  async requestApproval(event, result) {
    const proposal = result.proposal;
    if (!proposal) return null;
    validateProposal(event, proposal);

    const config = this.config;
    const permissionId = (
      await sha(`${config.requester_address}:${proposal.request_id}`)
    )
      .slice(0, 16)
      .toUpperCase();
    const originalEmail =
      event.email || (await this.read('customer/' + event.conversation_id));
    requireThat(
      !proposal.to || proposal.to === originalEmail.from_email,
      'wrong_agent_recipient',
    );
    const action = {
      type: 'email.send',
      ...actionMetadata(proposal),
      to: originalEmail.from_email,
      subject: proposal.subject,
      body_text: proposal.body_text,
      ...(/^<[^<>\s]{1,500}>$/.test(originalEmail?.message_id || '')
        ? { in_reply_to: originalEmail.message_id }
        : {}),
    };

    await this.write('request/' + permissionId, {
      conversation_id: event.conversation_id,
      client_request_id: proposal.request_id,
      customer_email: originalEmail,
      receipt_protocol:
        proposal.type === 'teammate.question'
          ? 'question.receipt/1'
          : 'permission.receipt/1',
    });

    const outboxKey = 'outbox/' + proposal.request_id;
    let payload = await this.read(outboxKey);
    if (!payload) {
      payload = await this.saveIfAbsent(
        outboxKey,
        this.buildPermissionEmail(proposal, action, originalEmail.id),
      );
    }

    // Reuse both the frozen payload and the provider idempotency key on retry.
    const sent = await this.mail.send(
      {
        ...payload,
        ...(payload.attachments?.length
          ? {
              attachments: await materializeAttachments(
                payload.attachments,
                this,
                originalEmail.from_email,
              ),
            }
          : {}),
      },
      'agent:permission:' + proposal.request_id,
    );
    requireThat(
      sent.id &&
        !['bounced', 'gate_denied', 'agent_failed', 'canceled'].includes(
          sent.status,
        ),
      'permission_delivery_failed',
    );

    return permissionId;
  }

  buildPermissionEmail(proposal, action, customerEmailId) {
    const payload = {
      from: this.config.requester_address,
      to: this.config.approval_address,
      subject: `Permission request ${proposal.request_id}`,
      body_text: JSON.stringify({
        protocol:
          proposal.type === 'teammate.question'
            ? 'question.request/1'
            : 'permission.request/1',
        request_id: proposal.request_id,
        created_at: new Date().toISOString(),
        context: {
          ...(this.config.customer_access === 'authenticated'
            ? { customer_email_id: customerEmailId }
            : {}),
          ...(proposal.sentinel
            ? { sentinel: sentinelDecision(proposal.sentinel) }
            : {}),
          ...(proposal.evidence?.length
            ? { output_attachment_count: proposal.attachments?.length || 0 }
            : {}),
        },
        action,
      }),
    };

    if (proposal.attachments?.length || proposal.evidence?.length) {
      payload.attachments = [
        ...(proposal.attachments || []),
        ...(proposal.evidence || []),
      ];
    }

    return payload;
  }
}

// Memories hold at most 64 KiB. Checkpoint provider references and reload large
// inbound files on retry; inline draft attachments remain part of the proposal.
function compactForMemory(value) {
  if (Array.isArray(value)) return value.map(compactForMemory);
  if (!value || typeof value !== 'object') return value;
  const entries = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'agent_result') continue;
    if (key === 'content_base64' && value.source_email_id) continue;
    entries.push([
      key,
      key === 'deferred_emails'
        ? entry.map((email) => ({ id: email.id, body_reference: true }))
        : compactForMemory(entry),
    ]);
  }
  return Object.fromEntries(entries);
}
