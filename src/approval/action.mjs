import { sha } from '../shared/crypto.mjs';
import { canonical } from '../shared/json.mjs';

export const actionHash = (action) =>
  sha(
    canonical({
      from: action.from,
      to: action.to,
      subject: action.subject,
      body_text: action.body_text,
      ...(action.in_reply_to ? { in_reply_to: action.in_reply_to } : {}),
      ...(action.resource
        ? {
            resource: action.resource,
          }
        : {}),
      attachments: action.attachments.map((attachment) => ({
        filename: attachment.filename,
        content_type: attachment.content_type,
        size_bytes: attachment.size_bytes,
        sha256: attachment.sha256,
        part_index: attachment.part_index,
      })),
      ...(action.evidence?.length ? { evidence: action.evidence } : {}),
    }),
  );

export const createToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
