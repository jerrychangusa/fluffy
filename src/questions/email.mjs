import {
  escapeHtml,
  fileSize,
  formatDeadline,
} from '../shared/email-format.mjs';

export function buildQuestionEmail(record, config, attachments) {
  const subject = `[Question ${record.id}] ${record.subject.replace(/^re:\s*/i, '')}`;
  const deadline = formatDeadline(record.expires_at, config.approver_timezone);
  const requestUrl = `https://www.primitive.dev/app/emails/inbox/${encodeURIComponent(record.source_email_id)}`;
  const instructions =
    'Reply in this thread with your answer. Your agent will continue helping the customer.';
  const authority =
    'Your reply supplies information. Restricted actions still need separate approval.';
  const files = record.evidence.length
    ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e3e7ed">
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#475467">${record.evidence.length === 1 ? '1 file attached for your review' : `${record.evidence.length} files attached for your review`}</p>
        ${record.evidence.map((file) => `<p style="margin:4px 0;font-size:13px;line-height:1.5;color:#344054;overflow-wrap:anywhere">${escapeHtml(file.filename)} <span style="color:#667085">&middot; ${fileSize(file.size_bytes)}</span></p>`).join('')}
      </div>`
    : '';
  return {
    from: config.approval_address,
    to: record.teammate,
    subject,
    body_text: [
      'Your agent has a question',
      '',
      record.question,
      '',
      instructions,
      authority,
      ...(record.evidence.length
        ? [
            '',
            'Attached for your review:',
            ...record.evidence.map(
              (file) => `${file.filename} (${fileSize(file.size_bytes)})`,
            ),
          ]
        : []),
      '',
      `Replies accepted until ${deadline}.`,
      `Reference ${record.id}`,
      `View question in Primitive: ${requestUrl}`,
    ].join('\n'),
    body_html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;color:#17212e;font-family:Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">An answer from you will let your agent continue this case.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e3e7ed;border-radius:12px">
        <tr><td style="padding:28px 24px 24px">
          <p style="margin:0 0 10px;font-size:12px;line-height:1.5;font-weight:700;letter-spacing:1px;color:#16705d">TEAMMATE QUESTION &middot; ${escapeHtml(record.role)}</p>
          <h1 style="margin:0 0 12px;font-size:26px;line-height:1.25;letter-spacing:-0.5px">Your agent needs an answer</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475467">${instructions}</p>
          <div style="padding:20px;background:#f8fafb;border:1px solid #e3e7ed;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.65">${escapeHtml(record.question)}</div>
          ${files}
          <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#475467">${authority}</p>
          <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#667085">Replies accepted until ${escapeHtml(deadline)}.</p>
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e3e7ed;font-size:11px;line-height:1.6;color:#667085">Reference ${escapeHtml(record.id)} &nbsp;&middot;&nbsp; <a href="${escapeHtml(requestUrl)}" style="color:#475467">View question in Primitive</a></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    attachments,
  };
}
