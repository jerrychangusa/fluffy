import { sha } from '../shared/crypto.mjs';
import { actionHash, createToken } from './action.mjs';
import { Retry, Rejected } from '../shared/errors.mjs';
import { requireThat, isPlainObject } from '../shared/validation.mjs';
import { authenticated } from '../integrations/primitive/authentication.mjs';
import { parseApprovalCommand } from './commands.mjs';
import { buildApprovalEmail } from './email.mjs';
import { parsePermissionRequest, createValidatedAction } from './requests.mjs';
import { approvalConfig } from '../shared/configuration.mjs';
import { sentinelDecision } from '../shared/sentinel.mjs';
export function publicRecord(record) {
  return {
    id: record.id,
    status: record.status,
    action: record.action,
    action_hash: record.hash,
    assessment: record.assessment,
    ...(record.sentinel ? { sentinel: record.sentinel } : {}),
    created_at: record.created_at,
    expires_at: record.expires_at,
    approval: record.approval
      ? {
          decision: record.approval.decision,
          by: record.approval.by,
          email_id: record.approval.email_id,
          at: record.approval.at,
        }
      : null,
    notification: record.notification,
    execution: record.execution,
    wake: record.wake
      ? {
          state: record.wake.state,
          wire_id: record.wake.wire_id,
          send_id: record.wake.send_id,
          transport: record.wake.transport,
        }
      : null,
    events: record.events,
  };
}

export class ApprovalService {
  constructor({
    store,
    mail,
    assess,
    config,
    now = () => Date.now(),
    prepareAction = createValidatedAction,
    requiresApproval = () => true,
    verifyAction = async () => {},
  }) {
    this.store = store;
    this.mail = mail;
    this.assess = assess;
    this.config = approvalConfig(config);
    this.now = now;
    this.prepareAction = prepareAction;
    this.requiresApproval = requiresApproval;
    this.verifyAction = verifyAction;
  }

  async handleEmail(email) {
    if (
      email.parsed?.status !== 'complete' ||
      !['accepted', 'completed'].includes(email.status)
    ) {
      throw new Retry('email_not_ready');
    }
    if (email.recipient === this.config.execution_address) {
      return this.receiveWake(email);
    }
    requireThat(
      email.recipient === this.config.approval_address,
      'wrong_mailbox',
    );
    if (email.from_email?.toLowerCase() === this.config.requester_address) {
      return this.receiveRequest(email);
    }
    return this.receiveApproval(email);
  }

  async receiveRequest(email) {
    const config = this.config;
    requireThat(
      authenticated(email, config.requester_address, config),
      'untrusted_requester',
    );
    const input = parsePermissionRequest(email);
    const id = (await sha(`${config.requester_address}:${input.request_id}`))
      .slice(0, 16)
      .toUpperCase();
    const existing = await this.store.get(id);
    if (existing) {
      requireThat(
        existing.value.client_id === input.request_id,
        'request_id_collision',
      );
      return this.continueRequest(id);
    }
    const submittedAt = Date.parse(input.created_at);
    requireThat(
      Number.isFinite(submittedAt) &&
        submittedAt <= this.now() + 60000 &&
        submittedAt >= this.now() - 30 * 60000,
      'stale_request',
    );
    const action = await this.prepareAction(input, email, config);
    const record = {
      id,
      client_id: input.request_id,
      source_email_id: email.id,
      source_message_id: email.message_id,
      requester: config.requester_address,
      approval_code: createToken(),
      action,
      ...(input.context?.sentinel
        ? { sentinel: sentinelDecision(input.context.sentinel) }
        : {}),
      hash: await actionHash(action),
      status: 'reviewing',
      created_at: this.now(),
      expires_at: this.now() + 30 * 60000,
      events: [],
      notification: { state: 'not_started' },
      execution: { state: 'not_started' },
      wake: { state: 'not_started' },
    };
    await this.loadVerifiedAttachments(record, true);
    this.event(
      record,
      'requested',
      'Agent requested permission by email; attached bytes verified.',
    );
    try {
      await this.store.put(id, record, { if_absent: true });
    } catch (error) {
      if (error.status !== 409) {
        throw error;
      }
    }
    return this.continueRequest(id);
  }

  async continueRequest(id) {
    let record = await this.record(id);
    if (record.status === 'reviewing') {
      const assessment = await this.assess(record.action);
      const automatic = await this.policyPermits(record, assessment);
      const changed = await this.edit(id, (updatedRecord) => {
        if (updatedRecord.status !== 'reviewing') {
          return false;
        }
        updatedRecord.assessment = assessment;
        updatedRecord.status =
          assessment.choice === 'deny'
            ? 'blocked'
            : automatic
              ? 'approved'
              : 'pending';
        if (automatic)
          updatedRecord.authorization = {
            kind: 'policy',
            action_hash: updatedRecord.hash,
          };
        this.event(
          updatedRecord,
          'assessed',
          `Jev: ${assessment.choice}. ${automatic ? 'Trusted policy permits this exact action.' : 'Human approval required or action blocked.'}`,
        );
        return true;
      });
      record = changed.record;
    }
    if (record.status === 'pending') {
      await this.notify(id);
    }
    if (record.status === 'approved') {
      await this.wake(id);
    }
    if (['pending', 'blocked'].includes(record.status)) {
      await this.receipt(id, 'pending');
    }
    return publicRecord(await this.record(id));
  }

  async policyPermits(record, assessment = record.assessment) {
    return (
      !(await this.requiresApproval(record.action)) &&
      record.sentinel?.decision === 'allow' &&
      record.sentinel.assessment.source === 'jev' &&
      record.sentinel.assessment.choice === 'allow' &&
      record.sentinel.assessment.confidence >= 0.8 &&
      assessment?.source === 'jev' &&
      assessment.choice === 'allow' &&
      Number.isFinite(assessment.confidence) &&
      assessment.confidence >= 0.8 &&
      assessment.confidence <= 1
    );
  }

  async receiveApproval(email) {
    const approvalCommand = parseApprovalCommand(
      email.parsed?.body_text ?? email.body_text,
    );
    requireThat(approvalCommand, 'not_an_approval');
    const config = this.config;
    requireThat(
      authenticated(email, config.approver, config, true),
      'untrusted_approver',
    );
    const result = await this.edit(approvalCommand.id, (record) => {
      if (record.approval?.email_id === email.id) {
        return false;
      }
      if (!record.notification.provider_id) {
        throw new Retry('notification_not_recorded');
      }
      requireThat(
        approvalCommand.code
          ? approvalCommand.code === record.approval_code
          : email.reply_to_sent_email_id === record.notification.provider_id,
        'wrong_approval_thread',
      );
      const receivedAt = Date.parse(email.received_at);
      requireThat(
        Number.isFinite(receivedAt) &&
          receivedAt >= record.created_at &&
          receivedAt <= record.expires_at &&
          this.now() < record.expires_at,
        'approval_expired',
      );
      if (approvalCommand.decision === 'REVOKE') {
        requireThat(
          ['pending', 'approved'].includes(record.status) &&
            record.execution.state === 'not_started',
          'already_consumed',
        );
        record.status = 'revoked';
      } else {
        requireThat(record.status === 'pending', 'request_not_pending');
        record.status = {
          APPROVE: 'approved',
          DENY: 'denied',
          CHANGE: 'changes_requested',
        }[approvalCommand.decision];
      }
      record.approval = {
        decision: approvalCommand.decision,
        by: config.approver,
        email_id: email.id,
        at: this.now(),
        action_hash: record.hash,
        note: approvalCommand.note,
      };
      this.event(
        record,
        record.status,
        `Authenticated ${approvalCommand.decision} received by email.`,
      );
      return true;
    });
    if (result.record.status === 'approved') {
      await this.wake(approvalCommand.id);
    } else if (result.changed) {
      await this.receipt(approvalCommand.id, 'final');
    }
    return publicRecord(await this.record(approvalCommand.id));
  }

  async wake(id) {
    // One native Wake send. Schedule is disabled before manual firing and removed
    // afterward; the function does not leave a recurring job behind.
    const claim = await this.edit(id, (record) => {
      if (
        record.status !== 'approved' ||
        record.wake.state !== 'not_started' ||
        record.expires_at <= this.now()
      ) {
        return false;
      }
      record.wake = {
        state: 'dispatching',
        token: createToken(),
        transport: 'native-wake-email',
      };
      this.event(
        record,
        'wake_requested',
        'Resuming through a native Primitive Wake dispatch.',
      );
      return true;
    });
    if (!claim.changed) {
      return;
    }
    try {
      const record = claim.record;
      const receipt = await this.mail.wake(
        { request_id: id, action_hash: record.hash, nonce: record.wake.token },
        id,
        async (schedule_id) => {
          await this.edit(id, (updatedRecord) => {
            updatedRecord.wake.schedule_id = schedule_id;
            return true;
          });
        },
      );
      await this.edit(id, (updatedRecord) => {
        Object.assign(updatedRecord.wake, { state: 'dispatched', ...receipt });
        this.event(
          updatedRecord,
          'wake_dispatched',
          'Primitive recorded and sent the Wake command.',
        );
        return true;
      });
    } catch {
      await this.edit(id, (record) => {
        record.wake.state = 'unknown';
        this.event(
          record,
          'wake_unknown',
          'Dispatch outcome needs reconciliation. No execution is permitted without the recorded dispatch.',
        );
        return true;
      });
    }
  }

  async receiveWake(email) {
    const config = this.config;
    requireThat(
      authenticated(email, config.approval_address, config),
      'untrusted_wake_sender',
    );
    const parts = email.parsed?.attachments || [];
    requireThat(
      parts.length === 1 &&
        parts[0].filename === 'interaction.json' &&
        parts[0].size_bytes < 16000,
      'invalid_wake_attachment',
    );
    const bytes = await this.mail.attachment(email.id, parts[0].part_index);
    requireThat(
      (await sha(bytes)) === parts[0].sha256,
      'wake_attachment_changed',
    );
    let envelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Rejected('invalid_wake_json');
    }
    requireThat(
      envelope.interaction_version === 1 &&
        envelope.protocol === 'wake.dispatch' &&
        envelope.protocol_version === 1 &&
        envelope.step === 'dispatch' &&
        envelope.payload?.command === 'resume_request',
      'invalid_wake_command',
    );
    const wakeArguments = envelope.payload.args;
    requireThat(
      isPlainObject(wakeArguments) &&
        /^[A-F0-9]{16}$/.test(wakeArguments.request_id),
      'invalid_wake_args',
    );
    const record = await this.record(wakeArguments.request_id);
    if (record.wake.state === 'dispatching') {
      throw new Retry('wake_receipt_not_recorded_yet');
    }
    requireThat(
      record.wake.state === 'dispatched' &&
        envelope.interaction_id === record.wake.wire_id &&
        envelope.step_id === record.wake.step_id &&
        wakeArguments.nonce === record.wake.token,
      'unrecorded_wake',
    );
    requireThat(
      email.message_id?.includes(`primitive-direct-${record.wake.send_id}@`),
      'wrong_wake_message',
    );
    return this.execute(record.id, wakeArguments.action_hash, email.id);
  }

  async execute(id, hash, wakeEmailId) {
    const record = await this.record(id);
    requireThat(
      hash === record.hash && (await actionHash(record.action)) === record.hash,
      'action_changed',
    );
    if (record.execution.state !== 'not_started') {
      await this.reconcile(id, 'execution');
      await this.receipt(id, 'final');
      return publicRecord(await this.record(id));
    }
    requireThat(
      record.status === 'approved' &&
        ((record.approval?.decision === 'APPROVE' &&
          record.approval.action_hash === record.hash) ||
          (record.authorization?.kind === 'policy' &&
            record.authorization.action_hash === record.hash &&
            (await this.policyPermits(record)))) &&
        record.expires_at > this.now(),
      'no_valid_permission',
    );
    try {
      await this.verifyAction(record.action);
    } catch {
      await this.edit(id, (updatedRecord) => {
        if (
          updatedRecord.execution.state !== 'not_started' ||
          updatedRecord.status !== 'approved'
        )
          return false;
        updatedRecord.status = 'blocked';
        this.event(
          updatedRecord,
          'blocked',
          'The approved resource changed or is no longer available. A fresh request is required.',
        );
        return true;
      });
      await this.receipt(id, 'final');
      return publicRecord(await this.record(id));
    }
    // Re-check review evidence too; only output attachments reach the customer.
    await this.loadVerifiedAttachments(record, true);
    const attachments = await this.loadVerifiedAttachments(record);
    const claim = await this.edit(id, (updatedRecord) => {
      if (updatedRecord.execution.state !== 'not_started') {
        return false;
      }
      requireThat(
        updatedRecord.status === 'approved' &&
          updatedRecord.expires_at > this.now(),
        'permission_no_longer_valid',
      );
      updatedRecord.status = 'executing';
      updatedRecord.execution = {
        state: 'sending',
        key: `hosted:execute:${id}`,
      };
      updatedRecord.wake.received_email_id = wakeEmailId;
      this.event(
        updatedRecord,
        'executing',
        'Atomically consumed the exact permission before sending.',
      );
      return true;
    });
    if (claim.changed) {
      try {
        const { from, to, subject, body_text, in_reply_to } = record.action;
        const content = {
          from,
          to,
          subject,
          body_text,
          ...(in_reply_to ? { in_reply_to } : {}),
        };
        await this.delivery(
          id,
          'execution',
          await this.mail.send(
            { ...content, attachments },
            claim.record.execution.key,
          ),
        );
      } catch {
        await this.edit(id, (updatedRecord) => {
          updatedRecord.status = 'execution_unknown';
          updatedRecord.execution.state = 'unknown';
          this.event(
            updatedRecord,
            'execution_unknown',
            'Unknown send result; only read-only reconciliation is allowed.',
          );
          return true;
        });
      }
    }
    await this.receipt(id, 'final');
    return publicRecord(await this.record(id));
  }

  async notify(id) {
    let record = await this.record(id);
    if (record.notification.state !== 'not_started') {
      return;
    }
    const attachments = await this.loadVerifiedAttachments(record, true);
    const claim = await this.edit(id, (updatedRecord) => {
      if (
        updatedRecord.status !== 'pending' ||
        updatedRecord.expires_at <= this.now() ||
        updatedRecord.notification.state !== 'not_started'
      ) {
        return false;
      }
      updatedRecord.notification = {
        state: 'sending',
        key: `hosted:approval:${id}`,
      };
      this.event(
        updatedRecord,
        'approval_requested',
        'Sending the exact proposal and attachments to the human approver.',
      );
      return true;
    });
    if (!claim.changed) {
      return;
    }
    record = claim.record;
    try {
      const sent = await this.mail.send(
        buildApprovalEmail(record, this.config, attachments),
        record.notification.key,
      );
      await this.delivery(id, 'notification', sent);
    } catch {
      await this.edit(id, (updatedRecord) => {
        updatedRecord.notification.state = 'unknown';
        this.event(
          updatedRecord,
          'notification_unknown',
          'Delivery outcome unknown; reconcile by idempotency key, never resend blindly.',
        );
        return true;
      });
    }
  }

  async receipt(id, phase) {
    const field = `receipt_${phase}`;
    const record = await this.record(id);
    if (
      phase === 'final' &&
      ![
        'executed',
        'execution_failed',
        'execution_unknown',
        'denied',
        'changes_requested',
        'revoked',
        'blocked',
        'expired',
      ].includes(record.status)
    ) {
      return;
    }
    const alreadySent = (updatedRecord) =>
      updatedRecord[field] &&
      (!updatedRecord[field].status ||
        updatedRecord[field].status === record.status);
    if (alreadySent(record)) {
      return;
    }
    const claim = await this.edit(id, (updatedRecord) => {
      if (alreadySent(updatedRecord)) {
        return false;
      }
      updatedRecord[field] = { state: 'sending', status: record.status };
      return true;
    });
    if (!claim.changed) {
      return;
    }
    const payload = {
      protocol: 'permission.receipt/1',
      request_id: id,
      client_request_id: record.client_id,
      status: record.status,
      action_hash: record.hash,
      expires_at: record.expires_at,
      execution: record.execution,
      decision: record.approval?.decision || null,
      feedback: record.approval?.note || '',
    };
    try {
      const sent = await this.mail.send(
        {
          from: this.config.approval_address,
          to: record.requester,
          subject: `Permission ${record.status}: ${id}`,
          body_text: JSON.stringify(payload, null, 2),
          in_reply_to: record.source_message_id,
          references: [record.source_message_id],
        },
        `hosted:receipt:${phase}:${id}:${record.status}`,
      );
      await this.edit(id, (updatedRecord) => {
        updatedRecord[field] = {
          state: sent.status,
          provider_id: sent.id,
          status: record.status,
        };
        return true;
      });
    } catch {
      await this.edit(id, (updatedRecord) => {
        updatedRecord[field] = { state: 'unknown', status: record.status };
        return true;
      });
    }
  }

  async delivery(id, field, sent) {
    requireThat(!!sent.id && !!sent.status, 'invalid_send_result');
    return this.edit(id, (record) => {
      if (
        record[field].provider_id === sent.id &&
        record[field].provider_status === sent.status
      ) {
        return false;
      }
      const failed = [
        'bounced',
        'gate_denied',
        'agent_failed',
        'canceled',
      ].includes(sent.status);
      record[field] = {
        ...record[field],
        provider_id: sent.id,
        provider_status: sent.status,
        state:
          sent.status === 'delivered'
            ? 'delivered'
            : failed
              ? 'failed'
              : 'pending_delivery',
      };
      if (field === 'execution') {
        record.status =
          sent.status === 'delivered'
            ? 'executed'
            : failed
              ? 'execution_failed'
              : 'executing';
      }
      this.event(
        record,
        `${field}_delivery`,
        `Primitive reports ${sent.status}.`,
      );
      return true;
    });
  }

  async reconcile(id, field) {
    const record = await this.record(id);
    const deliveryState = record[field];
    if (!deliveryState?.key || deliveryState.state === 'not_started') {
      return;
    }
    const items = await this.mail.lookup(deliveryState.key);
    if (items.length === 1) {
      await this.delivery(id, field, await this.mail.detail(items[0].id));
    }
  }

  async loadVerifiedAttachments(record, includeEvidence = false) {
    const attachments = [];
    for (const attachment of [
      ...record.action.attachments,
      ...(includeEvidence ? record.action.evidence || [] : []),
    ]) {
      const bytes = await this.mail.attachment(
        record.source_email_id,
        attachment.part_index,
      );
      requireThat(
        bytes.length === attachment.size_bytes &&
          (await sha(bytes)) === attachment.sha256,
        'attachment_changed',
      );
      attachments.push({
        filename: attachment.filename,
        content_type: attachment.content_type,
        content_base64: this.mail.base64(bytes),
      });
    }
    return attachments;
  }

  async record(id) {
    const memory = await this.store.get(id);
    if (!memory) {
      throw new Rejected('unknown_request');
    }
    return memory.value;
  }

  async edit(id, update) {
    // Concurrent webhooks must claim the same Memory version. A losing writer
    // reloads the record instead of overwriting approval or execution state.
    for (let attempt = 0; attempt < 8; attempt++) {
      const memory = await this.store.get(id);
      if (!memory) {
        throw new Rejected('unknown_request');
      }
      const record = structuredClone(memory.value);
      if (!update(record)) {
        return { changed: false, record };
      }
      try {
        await this.store.put(id, record, { if_version: memory.version });
        return { changed: true, record };
      } catch (error) {
        if (error.status !== 409) {
          throw error;
        }
      }
    }
    throw new Retry('concurrent_update');
  }

  event(record, kind, detail) {
    record.events.push({ at: this.now(), kind, detail });
    record.events = record.events.slice(-40);
  }
}
