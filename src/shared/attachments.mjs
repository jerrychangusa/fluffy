import { Rejected } from './errors.mjs';

export const validAttachmentName = (name) =>
  typeof name === 'string' &&
  name.trim().length > 0 &&
  name.length <= 120 &&
  !/[\x00-\x1f\x7f/\\]/.test(name);

// Large files travel as provider references; only small, trusted assets inline.
export function validateDraftAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > 3) {
    throw new Rejected('invalid_draft_attachments');
  }
  let encodedBytes = 0;
  return attachments.map((attachment) => {
    if (attachment?.source_email_id) {
      if (
        !/^[a-f0-9-]{36}$/i.test(attachment.source_email_id) ||
        !Number.isInteger(attachment.part_index) ||
        attachment.part_index < 0 ||
        !/^[a-f0-9]{64}$/.test(attachment.sha256 || '') ||
        !Number.isInteger(attachment.size_bytes) ||
        attachment.size_bytes <= 0 ||
        attachment.size_bytes > 3 * 1024 * 1024 ||
        !validAttachmentName(attachment.filename) ||
        !['text/plain', 'image/png', 'image/jpeg', 'application/pdf'].includes(
          attachment.content_type,
        )
      ) {
        throw new Rejected('invalid_attachment_reference');
      }
      const {
        source_email_id,
        part_index,
        sha256,
        size_bytes,
        filename,
        content_type,
      } = attachment;
      return {
        source_email_id,
        part_index,
        sha256,
        size_bytes,
        filename,
        content_type,
      };
    }
    if (
      !attachment ||
      !validAttachmentName(attachment.filename) ||
      !['text/plain', 'image/png', 'image/jpeg', 'application/pdf'].includes(
        attachment.content_type,
      ) ||
      typeof attachment.content_base64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        attachment.content_base64,
      ) ||
      !attachment.content_base64.length
    ) {
      throw new Rejected('invalid_draft_attachment');
    }
    encodedBytes += attachment.content_base64.length;
    if (encodedBytes > 16384) throw new Rejected('draft_attachments_too_large');
    return {
      filename: attachment.filename,
      content_type: attachment.content_type,
      content_base64: attachment.content_base64,
    };
  });
}
