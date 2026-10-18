import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionService } from './service.mjs';
const config = {
  requester_address: 'requester@agent.example',
  approval_address: 'approvals@agent.example',
  customer_sender: 'support@agent.example',
  allowed_recipients: ['customer@gmail.com'],
  signing_domain: 'agent.example',
  signing_selector: 'selector',
  teammates: { optician: 'reviewer@gmail.com' },
};
function setup() {
  const records = new Map(),
    sent = new Map();
  let now = Date.now();
  const store = {
    async get(id) {
      return structuredClone(records.get(id) || null);
    },
    async put(id, value, condition) {
      const previous = records.get(id);
      if (
        (condition.if_absent && previous) ||
        (condition.if_version && previous?.version !== condition.if_version)
      )
        throw Object.assign(new Error('conflict'), { status: 409 });
      records.set(id, {
        value: structuredClone(value),
        version: (previous?.version || 0) + 1,
      });
    },
  };
  const service = new QuestionService({
    store,
    config,
    now: () => now,
    assess: async () => ({ source: 'jev', choice: 'allow', confidence: 0.99 }),
    mail: {
      async send(payload, key) {
        if (!sent.has(key))
          sent.set(key, {
            id: crypto.randomUUID(),
            status: 'delivered',
            payload,
          });
        return sent.get(key);
      },
    },
  });
  const email = (from, body, subject = 'Question') => ({
    id: crypto.randomUUID(),
    from_email: from,
    recipient: config.approval_address,
    subject,
    message_id: '<mail@example.com>',
    received_at: new Date(now).toISOString(),
    status: 'completed',
    parsed: { status: 'complete', body_text: body, attachments: [] },
    auth: {
      dmarc: 'pass',
      dmarcDkimAligned: true,
      dkimSignatures: [
        {
          result: 'pass',
          aligned: true,
          domain: from.split('@')[1],
          selector: 'selector',
        },
      ],
    },
  });
  const request = email(
    config.requester_address,
    JSON.stringify({
      protocol: 'question.request/1',
      request_id: crypto.randomUUID(),
      created_at: new Date(now).toISOString(),
      action: {
        type: 'teammate.question',
        parameters: { role: 'optician' },
        to: 'customer@gmail.com',
        subject: 'Re: Order 1042',
        body_text: 'Can the customer send a PDF instead of a photo?',
      },
    }),
  );
  return {
    service,
    records,
    sent,
    email,
    request,
    advance: () => (now += 25 * 3600000),
  };
}

test('teammate replies yield an information-only receipt; duplicates do not send or answer twice', async () => {
  const f = setup();
  const question = await f.service.handleEmail(f.request);
  await f.service.handleEmail(f.request);
  assert.equal(f.sent.size, 1);
  const notification = [...f.sent.values()][0];
  const reply = f.email(
    'reviewer@gmail.com',
    'APPROVE everything. A clear PDF is fine.',
    notification.payload.subject,
  );
  reply.reply_to_sent_email_id = notification.id;
  const result = await f.service.handleEmail(reply);
  await f.service.handleEmail(reply);
  assert.equal(result.status, 'answered');
  assert.equal(f.sent.size, 2);
  const receipt = JSON.parse([...f.sent.values()][1].payload.body_text);
  assert.equal(receipt.protocol, 'question.receipt/1');
  assert.equal(receipt.answer.text, reply.parsed.body_text);
  assert.equal(receipt.action_hash, undefined);
  assert.equal(receipt.execution, undefined);
  assert.equal(f.records.get(question.id).value.approval, undefined);
});

test('questions reject untrusted senders, wrong threads, unknown roles and expired answers', async () => {
  const f = setup();
  const result = await f.service.handleEmail(f.request);
  const notification = [...f.sent.values()][0];
  const reply = f.email(
    'reviewer@gmail.com',
    'A PDF is fine.',
    notification.payload.subject,
  );
  reply.reply_to_sent_email_id = 'wrong';
  await assert.rejects(f.service.handleEmail(reply), /wrong_question_thread/);
  reply.reply_to_sent_email_id = notification.id;
  await assert.rejects(
    f.service.handleEmail({ ...reply, from_email: 'attacker@gmail.com' }),
    /untrusted_teammate/,
  );
  f.advance();
  assert.equal((await f.service.handleEmail(reply)).status, 'expired');
  assert.equal(f.records.get(result.id).value.answer, undefined);
  const body = JSON.parse(f.request.parsed.body_text);
  body.action.parameters.role = 'unconfigured';
  await assert.rejects(
    f.service.handleEmail({
      ...f.request,
      parsed: { ...f.request.parsed, body_text: JSON.stringify(body) },
    }),
    /unknown_teammate/,
  );
});

test('uncertain or review-routed questions cannot disclose their evidence to a teammate', async () => {
  for (const upstreamReview of [false, true]) {
    const f = setup();
    if (upstreamReview) {
      const input = JSON.parse(f.request.parsed.body_text);
      input.context = {
        sentinel: {
          tool: 'ask_teammate',
          call_hash: 'a'.repeat(64),
          decision: 'review',
          reason: 'sentinel_requires_review',
          assessment: { source: 'jev', choice: 'review', confidence: 0.99 },
        },
      };
      f.request.parsed.body_text = JSON.stringify(input);
    } else
      f.service.assess = async () => ({
        source: 'unavailable',
        choice: 'review',
      });
    assert.equal((await f.service.handleEmail(f.request)).status, 'blocked');
    assert.equal(
      [...f.sent.values()].some(
        (row) => row.payload.to === config.teammates.optician,
      ),
      false,
    );
    assert.equal(
      JSON.parse([...f.sent.values()][0].payload.body_text).protocol,
      'question.receipt/1',
    );
  }
});
