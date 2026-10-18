import { createHash } from 'node:crypto';
import { validateDraftAttachments } from '../shared/attachments.mjs';
import { sentinelDecision } from '../shared/sentinel.mjs';
import { actionMetadata } from '../shared/validation.mjs';

function requestId(eventId) {
  const hash = createHash('sha256')
    .update('permission:' + eventId)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function validateEvent(event) {
  if (
    !event ||
    !['customer', 'receipt'].includes(event.kind) ||
    !/^[-a-zA-Z0-9]{1,80}$/.test(event.id || '') ||
    !/^[-a-zA-Z0-9]{1,80}$/.test(event.conversation_id || '')
  ) {
    throw new Error('invalid_event');
  }
  if (
    event.kind === 'customer' &&
    (!event.email ||
      typeof event.email.body_text !== 'string' ||
      Buffer.byteLength(event.email.body_text) > 24000 ||
      !Array.isArray(event.email.attachments || []) ||
      (event.email.attachments || []).length > 3)
  ) {
    throw new Error('invalid_email');
  }
  if (
    event.kind === 'receipt' &&
    (!event.receipt || !/^[A-F0-9]{16}$/.test(event.receipt.request_id || ''))
  ) {
    throw new Error('invalid_receipt');
  }
  let attachmentBytes = 0;
  for (const attachment of event.email?.attachments || []) {
    if (
      !['text/plain', 'image/png', 'image/jpeg', 'application/pdf'].includes(
        attachment.content_type,
      ) ||
      typeof attachment.content_base64 !== 'string' ||
      attachment.content_base64.length > 4200000
    ) {
      throw new Error('invalid_attachment');
    }
    attachmentBytes += attachment.content_base64.length;
    if (attachmentBytes > 4200000) throw new Error('attachments_too_large');
  }
  return event;
}

export function draftAction(input, event) {
  if (
    event.kind === 'receipt' &&
    !['changes_requested', 'answered'].includes(event.receipt.status)
  ) {
    throw new Error('action_not_allowed_for_receipt');
  }
  if (
    typeof input.subject !== 'string' ||
    !input.subject.trim() ||
    input.subject.length > 250 ||
    /[\r\n\x00]/.test(input.subject)
  ) {
    throw new Error('invalid_subject');
  }
  if (
    typeof input.body_text !== 'string' ||
    !input.body_text.trim() ||
    Buffer.byteLength(input.body_text) > 24000
  ) {
    throw new Error('invalid_body');
  }
  return {
    request_id: requestId(event.id),
    ...actionMetadata(input),
    ...(input.to ? { to: input.to } : {}),
    subject: input.subject,
    body_text: input.body_text,
    attachments: validateDraftAttachments(input.attachments),
    ...(input.evidence?.length
      ? { evidence: validateDraftAttachments(input.evidence) }
      : {}),
    ...(input.sentinel ? { sentinel: sentinelDecision(input.sentinel) } : {}),
  };
}
