import { authenticated } from '../integrations/primitive/authentication.mjs';
import { requireThat } from '../shared/validation.mjs';
import { sha } from '../shared/crypto.mjs';
import { Rejected, Retry } from '../shared/errors.mjs';
import { createValidatedAction } from '../approval/requests.mjs';
import { sentinelDecision } from '../shared/sentinel.mjs';
import { buildQuestionEmail } from './email.mjs';

export const questionReference = (subject) =>
  /^(?:re:\s*)*\[Question ([A-F0-9]{16})\]/i
    .exec(subject || '')?.[1]
    ?.toUpperCase();

// Questions carry information, never an executable action or an approval grant.
// They share the existing internal inbox; no additional server is required.
export class QuestionService {
  constructor({ store, mail, config, assess, now = () => Date.now() }) {
    Object.assign(this, { store, mail, config, assess, now });
  }

  async handleEmail(email) {
    if (
      email.parsed?.status !== 'complete' ||
      !['accepted', 'completed'].includes(email.status)
    )
      throw new Retry('email_not_ready');
    requireThat(
      email.recipient === this.config.approval_address,
      'wrong_mailbox',
    );
    return email.from_email?.toLowerCase() === this.config.requester_address
      ? this.request(email)
      : this.answer(email);
  }

  async request(email) {
    requireThat(
      authenticated(email, this.config.requester_address, this.config),
      'untrusted_requester',
    );
    let input;
    try {
      input = JSON.parse(email.parsed.body_text);
    } catch {
      throw new Rejected('invalid_question_json');
    }
    requireThat(
      input.protocol === 'question.request/1' &&
        /^[a-f0-9-]{36}$/i.test(input.request_id || ''),
      'invalid_question',
    );
    requireThat(
      input.action?.type === 'teammate.question' &&
        Object.keys(input.action.parameters || {}).join() === 'role',
      'invalid_question_role',
    );
    const role = input.action.parameters.role;
    const teammate = this.config.teammates?.[role];
    requireThat(
      typeof teammate === 'string' &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(teammate),
      'unknown_teammate',
    );
    const id = (
      await sha(`${this.config.requester_address}:${input.request_id}`)
    )
      .slice(0, 16)
      .toUpperCase();
    let memory = await this.store.get(id);
    if (!memory) {
      const submitted = Date.parse(input.created_at);
      requireThat(
        Number.isFinite(submitted) &&
          submitted <= this.now() + 60000 &&
          submitted >= this.now() - 1800000,
        'stale_request',
      );
      const { parameters, ...message } = input.action;
      const validated = createValidatedAction(
        { ...input, action: { ...message, type: 'email.send' } },
        email,
        this.config,
      );
      const evidence = [
        ...validated.attachments,
        ...(validated.evidence || []),
      ];
      const assessment = await this.assess({
        kind: 'teammate_question',
        role,
        question: validated.body_text,
        evidence,
      });
      const sentinel = sentinelDecision(input.context?.sentinel);
      const confidentAllow = (value) =>
        value?.source === 'jev' &&
        value.choice === 'allow' &&
        Number.isFinite(value.confidence) &&
        value.confidence >= 0.8 &&
        value.confidence <= 1;
      const permitted =
        confidentAllow(assessment) &&
        (!sentinel ||
          (sentinel.decision === 'allow' &&
            confidentAllow(sentinel.assessment)));
      const record = {
        id,
        client_id: input.request_id,
        role,
        teammate,
        question: validated.body_text,
        subject: validated.subject,
        source_email_id: email.id,
        source_message_id: email.message_id,
        evidence,
        created_at: this.now(),
        expires_at: this.now() + 24 * 3600000,
        status: permitted ? 'pending' : 'blocked',
        assessment,
        ...(sentinel ? { sentinel } : {}),
      };
      await this.files(record);
      try {
        await this.store.put(id, record, { if_absent: true });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      memory = await this.store.get(id);
    }
    const record = memory.value;
    requireThat(record.client_id === input.request_id, 'request_id_collision');
    if (record.status === 'pending' && !record.notification) {
      const sent = await this.mail.send(
        buildQuestionEmail(record, this.config, await this.files(record)),
        `question:notify:${id}`,
      );
      requireThat(
        sent.id &&
          !['bounced', 'gate_denied', 'agent_failed', 'canceled'].includes(
            sent.status,
          ),
        'question_delivery_failed',
      );
      await this.edit(id, (current) => {
        current.notification ||= { provider_id: sent.id };
      });
    }
    if (record.status !== 'pending') await this.receipt(id);
    return { id, status: record.status };
  }

  async answer(email) {
    const id = questionReference(email.subject);
    requireThat(id, 'not_a_question_reply');
    const record = (await this.store.get(id))?.value;
    requireThat(record, 'unknown_question');
    requireThat(
      authenticated(email, record.teammate, this.config, true),
      'untrusted_teammate',
    );
    if (!record.notification) throw new Retry('notification_not_recorded');
    requireThat(
      email.reply_to_sent_email_id === record.notification.provider_id,
      'wrong_question_thread',
    );
    const answer = email.parsed.body_text?.trim();
    requireThat(
      typeof answer === 'string' && answer.length > 0 && answer.length <= 12000,
      'invalid_teammate_answer',
    );
    const received = Date.parse(email.received_at);
    requireThat(
      Number.isFinite(received) && received >= record.created_at,
      'invalid_reply_time',
    );
    await this.edit(id, (current) => {
      if (current.status !== 'pending') return;
      if (this.now() >= current.expires_at || received > current.expires_at) {
        current.status = 'expired';
        return;
      }
      current.status = 'answered';
      current.answer = {
        text: answer,
        by: current.teammate,
        role: current.role,
        email_id: email.id,
        at: received,
      };
    });
    await this.receipt(id);
    return { id, status: (await this.store.get(id)).value.status };
  }

  async receipt(id) {
    const record = (await this.store.get(id)).value;
    if (record.receipt_id || record.status === 'pending') return;
    const sent = await this.mail.send(
      {
        from: this.config.approval_address,
        to: this.config.requester_address,
        subject: `Question ${record.status}: ${id}`,
        in_reply_to: record.source_message_id,
        body_text: JSON.stringify({
          protocol: 'question.receipt/1',
          request_id: id,
          client_request_id: record.client_id,
          status: record.status,
          answer: record.answer || null,
        }),
      },
      `question:receipt:${id}`,
    );
    requireThat(sent.id, 'question_receipt_failed');
    await this.edit(id, (current) => {
      current.receipt_id ||= sent.id;
    });
  }

  async files(record) {
    const files = [];
    for (const file of record.evidence) {
      const bytes = await this.mail.attachment(
        record.source_email_id,
        file.part_index,
      );
      requireThat(
        bytes.length === file.size_bytes && (await sha(bytes)) === file.sha256,
        'attachment_changed',
      );
      files.push({
        filename: file.filename,
        content_type: file.content_type,
        content_base64: this.mail.base64(bytes),
      });
    }
    return files;
  }

  async edit(id, update) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const memory = await this.store.get(id);
      requireThat(memory, 'unknown_question');
      const record = structuredClone(memory.value);
      update(record);
      if (JSON.stringify(record) === JSON.stringify(memory.value)) return;
      try {
        await this.store.put(id, record, { if_version: memory.version });
        return;
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
    throw new Retry('concurrent_update');
  }
}
