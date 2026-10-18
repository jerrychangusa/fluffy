import { sha } from '../shared/crypto.mjs';
import { Rejected } from '../shared/errors.mjs';

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'image/png',
  'image/jpeg',
  'application/pdf',
]);

async function loadVerifiedAttachment(attachment, mail) {
  const bytes = await mail.attachment(
    attachment.source_email_id,
    attachment.part_index,
  );

  if (
    bytes.length !== attachment.size_bytes ||
    (await sha(bytes)) !== attachment.sha256
  ) {
    throw new Rejected('attachment_changed');
  }

  return { ...attachment, content_base64: mail.base64(bytes) };
}

// The model never chooses arbitrary provider files. Even trusted application
// references must belong to this authenticated customer before they are forwarded.
export async function materializeAttachments(
  references,
  { api, mail, config },
  customer,
) {
  const output = [];
  let size = 0;
  for (const reference of references) {
    let attachment = reference;
    if (reference.source_email_id) {
      const source = await api('/emails/' + reference.source_email_id);
      if (
        source.from_email?.toLowerCase() !== customer ||
        source.recipient !== config.customer_sender
      ) {
        throw new Rejected('attachment_customer_mismatch');
      }
      const original = source.parsed?.attachments?.find(
        (part) => part.part_index === reference.part_index,
      );
      if (
        !original ||
        original.sha256 !== reference.sha256 ||
        original.size_bytes !== reference.size_bytes
      ) {
        throw new Rejected('attachment_reference_changed');
      }
      attachment = await loadVerifiedAttachment(reference, mail);
    }
    size += Math.ceil((attachment.content_base64.length * 3) / 4);
    if (size > MAX_ATTACHMENT_BYTES || output.length >= MAX_ATTACHMENTS)
      throw new Rejected('attachments_too_large');
    const { filename, content_type, content_base64 } = attachment;
    output.push({ filename, content_type, content_base64 });
  }
  return output;
}

export async function loadCustomerAttachments(email, mail) {
  const attachments = [];

  for (const attachment of email.parsed.attachments || []) {
    const withinLimits =
      attachments.length < MAX_ATTACHMENTS &&
      ALLOWED_CONTENT_TYPES.has(attachment.content_type) &&
      attachment.size_bytes > 0 &&
      attachment.size_bytes <= MAX_ATTACHMENT_BYTES;

    if (!withinLimits) {
      throw new Rejected('attachment_outside_limits');
    }

    attachments.push(
      await loadVerifiedAttachment(
        {
          source_email_id: email.id,
          part_index: attachment.part_index,
          sha256: attachment.sha256,
          filename: attachment.filename,
          content_type: attachment.content_type,
          size_bytes: attachment.size_bytes,
        },
        mail,
      ),
    );
  }

  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.size_bytes,
    0,
  );
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Rejected('attachments_too_large');
  }

  return attachments;
}

export async function hydrateEvent(event, { api, mail }) {
  if (!event.email) return event;

  let email = event.email;

  if (email.body_reference) {
    if (!/^[a-f0-9-]{36}$/i.test(email.id)) {
      throw new Rejected('invalid_email_reference');
    }

    const original = await api('/emails/' + email.id);
    email = {
      id: original.id,
      from_email: original.from_email.toLowerCase(),
      message_id: original.message_id,
      subject: original.subject,
      body_text: original.parsed.body_text,
      attachments: (original.parsed.attachments || []).map((attachment) => ({
        ...attachment,
        source_email_id: original.id,
      })),
    };
  }

  const attachments = [];
  for (const attachment of email.attachments || []) {
    attachments.push(
      attachment.content_base64
        ? attachment
        : await loadVerifiedAttachment(attachment, mail),
    );
  }

  return { ...event, email: { ...email, attachments } };
}
