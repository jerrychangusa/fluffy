import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalEmail } from './email.mjs';
import { parseApprovalCommand } from './commands.mjs';
import { approvalConfig } from '../shared/configuration.mjs';

const config = {
  approval_address: 'approvals@example.com',
  requester_address: 'requester@example.com',
  customer_sender: 'support@example.com',
  execution_address: 'executor@example.com',
  approver: 'owner@example.com',
  allowed_recipients: ['customer@example.com'],
  signing_domain: 'example.com',
  signing_selector: 'approval',
  approver_timezone: 'America/Los_Angeles',
};
const record = {
  id: '47AC36F9A43CA6EC',
  source_email_id: '11111111-1111-4111-a111-111111111111',
  approval_code: 'A'.repeat(32),
  hash: '9'.repeat(64),
  expires_at: Date.parse('2026-10-18T06:14:37.634Z'),
  sentinel: {
    tool: 'send_email',
    reason: 'human_approval_required',
    call_hash: '8'.repeat(64),
    assessment: { source: 'jev', choice: 'review' },
  },
  action: {
    from: 'support@example.com',
    to: 'customer@example.com',
    subject: 'Re: Order #1042',
    body_text: 'Hi,\n\nPlease reply with your prescription.\n\nThank you!',
    attachments: [],
  },
};

test('the approval preview shows the exact message and a readable deadline, without audit noise', () => {
  const before = structuredClone(record);
  const email = buildApprovalEmail(record, config, []);
  assert.equal(email.subject, 'Approval needed: Order #1042');
  assert.ok(email.body_text.includes(record.action.body_text));
  assert.ok(email.body_html.includes(record.action.body_text));
  assert.match(email.body_text, /Oct 17, 2026, 11:14 PM PDT/);
  assert.match(email.body_html, /Approve email/);
  assert.match(email.body_html, /Request changes/);
  assert.match(email.body_html, /Decline/);
  assert.match(email.body_html, /Press <strong>Send<\/strong> to confirm/);
  assert.match(email.body_html, /View request in Primitive/);
  assert.doesNotMatch(email.body_html, /attachment will be sent/);
  for (const body of [email.body_text, email.body_html]) {
    assert.equal(body.includes(record.hash), false);
    assert.equal(body.includes(record.sentinel.call_hash), false);
    assert.doesNotMatch(
      body,
      /Hosted approval|SHA-256|Intercepted tool|human_approval_required/,
    );
  }
  assert.deepEqual(record, before);
});

test('all three buttons preserve approver identity, request binding, and strict reply commands', () => {
  const email = buildApprovalEmail(record, config, []);
  const links = [...email.body_html.matchAll(/href="(mailto:[^"]+)"/g)];
  assert.equal(links.length, 3);
  const decisions = [];
  for (const [, href] of links) {
    const url = new URL(href.replace(/&amp;/g, '&'));
    assert.equal(url.pathname, config.approval_address);
    assert.equal(url.searchParams.get('subject'), 'Re: ' + email.subject);
    let body = url.searchParams.get('body');
    if (body.startsWith('CHANGE')) {
      assert.equal(parseApprovalCommand(body), null);
      assert.ok(body.endsWith('\n\n'));
      body += 'Make the opening warmer.';
    }
    const command = parseApprovalCommand(body);
    assert.equal(command.id, record.id);
    assert.equal(command.code, record.approval_code);
    if (command.decision === 'CHANGE')
      assert.equal(command.note, 'Make the opening warmer.');
    decisions.push(command.decision);
  }
  assert.deepEqual(decisions, ['APPROVE', 'CHANGE', 'DENY']);
  assert.equal(parseApprovalCommand('CHANGE ' + record.id), null);
  assert.equal(parseApprovalCommand('CHANGE ' + record.id + '\n  '), null);
});

test('message HTML is escaped and actual attachments are listed and passed through unchanged', () => {
  const request = structuredClone(record);
  request.action.subject = 'Re: <img src=x onerror=alert(1)>';
  request.action.body_text =
    '<script>alert("secret")</script>\n  Keep these spaces & line breaks.';
  request.action.attachments = [
    { filename: 'prescription.pdf', size_bytes: 1536, sha256: '7'.repeat(64) },
  ];
  const files = [
    {
      filename: 'prescription.pdf',
      content_type: 'application/pdf',
      content_base64: 'cGRm',
    },
  ];
  const email = buildApprovalEmail(request, config, files);
  assert.doesNotMatch(email.body_html, /<script>|<img/);
  assert.match(
    email.body_html,
    /&lt;script&gt;alert\(&quot;secret&quot;\)&lt;\/script&gt;/,
  );
  assert.ok(email.body_text.includes(request.action.body_text));
  assert.match(email.body_html, /1 attachment will be sent/);
  assert.match(email.body_html, /prescription\.pdf/);
  assert.match(email.body_html, /2 KB/);
  assert.strictEqual(email.attachments, files);
  assert.equal(
    email.body_html.includes(request.action.attachments[0].sha256),
    false,
  );
});

test('approval deadlines use an explicit timezone and reject invalid configured zones', () => {
  const { approver_timezone, ...utcConfig } = config;
  assert.match(
    buildApprovalEmail(record, utcConfig, []).body_text,
    /Oct 18, 2026, 6:14 AM UTC/,
  );
  assert.equal(approvalConfig(config), config);
  assert.throws(
    () => approvalConfig({ ...config, approver_timezone: 'wrong/place' }),
    /invalid_config_approver_timezone/,
  );
  assert.throws(
    () => approvalConfig({ ...config, approver_timezone: '' }),
    /invalid_config_approver_timezone/,
  );
});
