import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionEmail } from './email.mjs';

const record = {
  id: '3022D357A6BC691A',
  source_email_id: 'source-email',
  subject: 'Re: Order 1042',
  teammate: 'reviewer@example.com',
  role: 'optician',
  question:
    'Is this date acceptable for administrative intake?\nPD supplied: 31 / 31.',
  expires_at: Date.parse('2026-10-18T06:14:37.634Z'),
  evidence: [],
};
const config = {
  approval_address: 'approvals@example.com',
  approver_timezone: 'America/Los_Angeles',
};

test('a teammate question preserves context and directs an information-only reply in the original thread', () => {
  const before = structuredClone(record);
  const email = buildQuestionEmail(record, config, []);
  assert.equal(email.subject, '[Question 3022D357A6BC691A] Order 1042');
  assert.equal(email.to, record.teammate);
  for (const body of [email.body_text, email.body_html]) {
    assert.ok(body.includes(record.question));
    assert.match(body, /Reply in this thread/);
    assert.match(body, /Restricted actions still need separate approval/);
    assert.match(body, /Oct 17, 2026, 11:14 PM PDT/);
    assert.match(body, /View question in Primitive/);
    assert.doesNotMatch(body, /mailto:|APPROVE|SHA-256/);
  }
  assert.deepEqual(record, before);
});

test('question content and file names are escaped, while review files pass through unchanged', () => {
  const input = {
    ...record,
    role: '<script>role</script>',
    question: '<img src=x onerror=alert(1)> & "question"',
    evidence: [{ filename: '<unsafe>.pdf', size_bytes: 1536 }],
  };
  const files = [{ filename: '<unsafe>.pdf', content_base64: 'cGRm' }];
  const email = buildQuestionEmail(input, config, files);
  assert.ok(email.body_text.includes(input.question));
  assert.doesNotMatch(email.body_html, /<script>|<img|<unsafe>/);
  assert.match(
    email.body_html,
    /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;question&quot;/,
  );
  assert.match(email.body_html, /&lt;unsafe&gt;\.pdf/);
  assert.match(email.body_html, /1 file attached for your review/);
  assert.match(email.body_html, /2 KB/);
  assert.strictEqual(email.attachments, files);
});
