import {
  escapeHtml,
  fileSize,
  formatDeadline,
} from '../shared/email-format.mjs';

function approvalLink(config, record, subject, decision) {
  const body = `${decision} ${record.id} ${record.approval_code}`;
  return `mailto:${config.approval_address}?subject=${encodeURIComponent('Re: ' + subject)}&body=${encodeURIComponent(body + (decision === 'CHANGE' ? '\n\n' : ''))}`;
}

function approvalHtml(record, { subject, deadline, links, requestUrl }) {
  const { action } = record;
  const files = action.attachments.length
    ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e3e7ed">
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#475467">${action.attachments.length === 1 ? '1 attachment will be sent' : `${action.attachments.length} attachments will be sent`}</p>
        ${action.attachments.map((file) => `<p style="margin:4px 0;font-size:13px;color:#344054;overflow-wrap:anywhere">${escapeHtml(file.filename)} <span style="color:#667085">&middot; ${fileSize(file.size_bytes)}</span></p>`).join('')}
      </div>`
    : '';

  // Tables and inline styles keep the layout usable in email clients. The
  // message is escaped as text, preserving its exact whitespace for review.
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;color:#17212e;font-family:Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Review your agent's email to ${escapeHtml(action.to)}. Nothing will be sent until you approve.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e3e7ed;border-radius:12px">
        <tr><td style="padding:28px 24px 20px">
          <p style="margin:0 0 10px;font-size:12px;line-height:1.5;font-weight:700;letter-spacing:1px;color:#16705d">APPROVAL REQUEST</p>
          <h1 style="margin:0 0 10px;font-size:26px;line-height:1.25;letter-spacing:-0.5px;color:#17212e">${escapeHtml(action.resource?.review_title || 'Review this email')}</h1>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#475467">Your agent has drafted the message below and is waiting for your decision. It hasn’t been sent.</p>
          ${action.evidence?.length ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#475467">Attached for your review only: ${action.evidence.map((file) => escapeHtml(file.filename)).join(', ')}. These files will not be sent to the customer.</p>` : ''}
          ${action.resource ? `<p style="margin:14px 0 0;padding:10px 12px;background:#fff6e8;border-radius:6px;font-size:14px;line-height:1.5;color:#754c16">${escapeHtml(action.resource.label)} &middot; ${action.resource.requires_approval ? 'A teammate must approve this step.' : 'Additional review requested by the policy sentinel.'}</p>` : ''}
          <p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#667085">Approval expires ${escapeHtml(deadline)}.</p>
        </td></tr>
        <tr><td style="padding:0 24px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e3e7ed">
            <tr><td style="padding:18px 0">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;line-height:1.7">
                <tr><td width="62" valign="top" style="color:#667085;padding:2px 0">To</td><td style="padding:2px 0;overflow-wrap:anywhere;font-weight:600;color:#17212e">${escapeHtml(action.to)}</td></tr>
                <tr><td valign="top" style="color:#667085;padding:2px 0">From</td><td style="padding:2px 0;overflow-wrap:anywhere;color:#475467">${escapeHtml(action.from)}</td></tr>
                <tr><td valign="top" style="color:#667085;padding:2px 0">Subject</td><td style="padding:2px 0;overflow-wrap:anywhere;color:#17212e">${escapeHtml(action.subject)}</td></tr>
              </table>
            </td></tr>
          </table>
          <div style="padding:20px;background:#f8fafb;border:1px solid #e3e7ed;border-radius:8px">
            <div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.65;color:#17212e">${escapeHtml(action.body_text)}</div>
            ${files}
          </div>
        </td></tr>
        <tr><td style="padding:24px">
          <p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:#475467">Approve the exact message${action.attachments.length ? ' and attachments' : ''} above, or ask your agent to revise it.</p>
          <a href="${escapeHtml(links.APPROVE)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 20px;border:1px solid #166b57;border-radius:7px;background:#166b57;color:#ffffff;font-size:14px;font-weight:600;line-height:1.4;text-decoration:none">Approve email</a>
          <a href="${escapeHtml(links.CHANGE)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 16px;border:1px solid #cbd3dc;border-radius:7px;background:#ffffff;color:#17212e;font-size:14px;font-weight:600;line-height:1.4;text-decoration:none">Request changes</a>
          <a href="${escapeHtml(links.DENY)}" style="display:inline-block;margin:0 0 8px;padding:12px 10px;color:#475467;font-size:14px;line-height:1.4;text-decoration:underline">Decline</a>
          <p style="margin:4px 0 0;font-size:12px;line-height:1.6;color:#667085">Buttons open an email reply. Press <strong>Send</strong> to confirm your decision. For changes, add your instructions below the first line.</p>
          <p style="margin:18px 0 0;font-size:12px;line-height:1.7;color:#667085">Prefer to reply directly? Send <span style="color:#344054">APPROVE ${escapeHtml(record.id)}</span> or <span style="color:#344054">DENY ${escapeHtml(record.id)}</span>.</p>
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e3e7ed;font-size:11px;line-height:1.6;color:#667085">
          Reference ${escapeHtml(record.id)} &nbsp;&middot;&nbsp; <a href="${escapeHtml(requestUrl)}" style="color:#475467;text-decoration:underline">View request in Primitive</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function buildApprovalEmail(record, config, attachments) {
  const { action } = record;
  const subject = `Approval needed: ${action.subject.replace(/^re:\s*/i, '')}`;
  const deadline = formatDeadline(record.expires_at, config.approver_timezone);
  const links = Object.fromEntries(
    ['APPROVE', 'CHANGE', 'DENY'].map((decision) => [
      decision,
      approvalLink(config, record, subject, decision),
    ]),
  );
  const requestUrl = `https://www.primitive.dev/app/emails/inbox/${encodeURIComponent(record.source_email_id)}`;
  const bodyText = [
    action.resource?.review_title || 'Review this email',
    'Your agent is waiting for your decision. This message has not been sent.',
    ...(action.resource
      ? [
          `${action.resource.label}: ${action.resource.requires_approval ? 'a teammate must approve this step.' : 'additional review requested by the policy sentinel.'}`,
        ]
      : []),
    ...(action.evidence?.length
      ? [
          'Review-only attachments: ' +
            action.evidence.map((file) => file.filename).join(', '),
          'These files will not be sent to the customer.',
        ]
      : []),
    `Approval expires ${deadline}.`,
    '',
    `To: ${action.to}`,
    `From: ${action.from}`,
    `Subject: ${action.subject}`,
    '',
    action.body_text,
    ...(action.attachments.length
      ? [
          '',
          'Attachments to send:',
          ...action.attachments.map(
            (file) => `${file.filename} (${fileSize(file.size_bytes)})`,
          ),
        ]
      : []),
    '',
    'To approve, reply with:',
    `APPROVE ${record.id}`,
    '',
    'To decline, reply with:',
    `DENY ${record.id}`,
    '',
    'To request changes, reply with:',
    `CHANGE ${record.id}`,
    'Describe your changes on the next line.',
    '',
    'Approval applies only to the exact message and attachments shown above.',
    `View request in Primitive: ${requestUrl}`,
  ].join('\n');

  return {
    from: config.approval_address,
    to: config.approver,
    subject,
    body_text: bodyText,
    body_html: approvalHtml(record, { subject, deadline, links, requestUrl }),
    attachments,
  };
}
