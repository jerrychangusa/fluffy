import { Rejected } from '../shared/errors.mjs';
import { requireThat, isPlainObject } from '../shared/validation.mjs';
import { encodeUtf8 } from '../shared/crypto.mjs';
import { validAttachmentName } from '../shared/attachments.mjs';
import { validEmailAddress } from '../shared/configuration.mjs';

export function parsePermissionRequest(email) {
  let input;
  try {
    input = JSON.parse(email.parsed?.body_text ?? email.body_text);
  } catch {
    throw new Rejected('invalid_request_json');
  }
  requireThat(
    isPlainObject(input) &&
      input.protocol === 'permission.request/1' &&
      typeof input.request_id === 'string' &&
      /^[a-f0-9-]{36}$/i.test(input.request_id),
    'invalid_request',
  );
  return input;
}

export function createValidatedAction(input, email, config) {
  const proposedAction = input.action;
  requireThat(
    isPlainObject(proposedAction) &&
      proposedAction.type === 'email.send' &&
      Object.keys(proposedAction).every((field) =>
        ['type', 'to', 'subject', 'body_text', 'in_reply_to'].includes(field),
      ),
    'unsupported_action',
  );
  requireThat(
    proposedAction.in_reply_to === undefined ||
      (typeof proposedAction.in_reply_to === 'string' &&
        /^<[^<>\s]{1,500}>$/.test(proposedAction.in_reply_to)),
    'invalid_reply_reference',
  );
  requireThat(
    validEmailAddress(proposedAction.to) &&
      (config.customer_access === 'authenticated' ||
        config.allowed_recipients.includes(proposedAction.to)),
    'recipient_not_allowed',
  );
  requireThat(
    typeof proposedAction.subject === 'string' &&
      proposedAction.subject.trim() &&
      proposedAction.subject.length <= 250 &&
      !/[\r\n\x00]/.test(proposedAction.subject),
    'invalid_subject',
  );
  requireThat(
    typeof proposedAction.body_text === 'string' &&
      proposedAction.body_text.trim() &&
      encodeUtf8(proposedAction.body_text).length <= 24000,
    'invalid_body',
  );
  const attachments = (email.parsed?.attachments || []).map((attachment) => {
    requireThat(
      validAttachmentName(attachment.filename) &&
        ['text/plain', 'image/png', 'image/jpeg', 'application/pdf'].includes(
          attachment.content_type,
        ),
      'invalid_attachment',
    );
    requireThat(
      Number.isInteger(attachment.part_index) &&
        attachment.part_index >= 0 &&
        Number.isInteger(attachment.size_bytes) &&
        attachment.size_bytes > 0 &&
        /^[a-f0-9]{64}$/.test(attachment.sha256),
      'invalid_attachment_metadata',
    );
    return {
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      part_index: attachment.part_index,
    };
  });
  requireThat(
    attachments.length <= 3 &&
      attachments.reduce(
        (total, attachment) => total + attachment.size_bytes,
        0,
      ) <=
        3 * 1024 * 1024,
    'attachments_too_large',
  );
  const outputCount =
    input.context?.output_attachment_count ?? attachments.length;
  requireThat(
    Number.isInteger(outputCount) &&
      outputCount >= 0 &&
      outputCount <= attachments.length,
    'invalid_attachment_roles',
  );
  return {
    from: config.customer_sender,
    to: proposedAction.to,
    subject: proposedAction.subject,
    body_text: proposedAction.body_text,
    ...(proposedAction.in_reply_to
      ? { in_reply_to: proposedAction.in_reply_to }
      : {}),
    attachments: attachments.slice(0, outputCount),
    ...(outputCount < attachments.length
      ? { evidence: attachments.slice(outputCount) }
      : {}),
  };
}
