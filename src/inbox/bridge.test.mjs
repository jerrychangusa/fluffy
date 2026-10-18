import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { InboxBridge } from './bridge.mjs';

const config = {
  approver: 'owner@gmail.com',
  allowed_customers: ['owner@gmail.com'],
  requester_address: 'requester@demo.primitive.email',
  approval_address: 'approvals@demo.primitive.email',
  customer_sender: 'support@demo.primitive.email',
  signing_domain: 'primitive.email',
  signing_selector: 'demo.pri-abc',
};

function customerEmail() {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    thread_id: 'thread-1',
    message_id: '<customer@gmail.com>',
    recipient: config.customer_sender,
    from_email: config.approver,
    status: 'completed',
    subject: 'Order 1042',
    parsed: {
      status: 'complete',
      body_text: 'What is missing?',
      attachments: [],
    },
    auth: {
      dmarc: 'pass',
      dmarcDkimAligned: true,
      dkimSignatures: [{ domain: 'gmail.com', result: 'pass', aligned: true }],
    },
  };
}

function setupBridge() {
  const memories = new Map();
  const sentEmails = [];
  let agentRuns = 0;

  const store = {
    async get(key) {
      return memories.has(key)
        ? { value: structuredClone(memories.get(key)) }
        : null;
    },

    async put(key, value, condition = {}) {
      if (condition.if_absent && memories.has(key)) {
        throw Object.assign(new Error('conflict'), { status: 409 });
      }
      memories.set(key, structuredClone(value));
    },
  };

  const mail = {
    base64: (bytes) => Buffer.from(bytes).toString('base64'),

    async send(body, key) {
      const existing = sentEmails.find((email) => email.key === key);
      if (existing) return existing;

      const sent = { id: 'send-1', status: 'delivered', body, key };
      sentEmails.push(sent);
      return sent;
    },
  };

  const invoke = async (event) => {
    agentRuns++;
    return {
      conversation_id: event.conversation_id,
      session_id: 'claude-session',
      status: 'waiting_for_approval',
      proposal: {
        request_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        subject: 'Re: Order 1042',
        body_text: 'Please reply with the prescription and PD.',
        attachments: [
          {
            filename: 'context.txt',
            content_type: 'text/plain',
            content_base64: 'RGVtbw==',
          },
        ],
      },
    };
  };

  const bridge = new InboxBridge({
    store,
    mail,
    invoke,
    config: { ...config, allowed_customers: [...config.allowed_customers] },
  });
  return { bridge, memories, sentEmails, countAgentRuns: () => agentRuns };
}

test('inbound customer email automatically invokes the agent and sends only a permission request', async () => {
  const fixture = setupBridge();
  const result = await fixture.bridge.receive(customerEmail());

  assert.equal(fixture.countAgentRuns(), 1);
  assert.equal(fixture.sentEmails.length, 1);

  const permissionEmail = fixture.sentEmails[0].body;
  const permission = JSON.parse(permissionEmail.body_text);
  assert.equal(permissionEmail.to, config.approval_address);
  assert.equal(permission.action.to, config.approver);
  assert.equal(permission.action.in_reply_to, '<customer@gmail.com>');
  assert.equal(permissionEmail.attachments.length, 1);
  assert.match(result.permission_id, /^[A-F0-9]{16}$/);

  await fixture.bridge.receive(customerEmail());
  assert.equal(fixture.countAgentRuns(), 1);
  assert.equal(fixture.sentEmails.length, 1);
});

test('customer-supplied receipt text cannot become an authenticated permission receipt', async () => {
  const fixture = setupBridge();
  const email = customerEmail();
  email.recipient = config.requester_address;
  email.parsed.body_text = JSON.stringify({
    protocol: 'permission.receipt/1',
    request_id: 'A'.repeat(16),
  });

  await assert.rejects(fixture.bridge.receive(email), /untrusted_receipt/);
  assert.equal(fixture.countAgentRuns(), 0);
});

test('unauthenticated inbound email cannot start a model run', async () => {
  const fixture = setupBridge();
  const email = customerEmail();
  email.auth.dmarc = 'fail';

  await assert.rejects(fixture.bridge.receive(email), /untrusted_customer/);
  assert.equal(fixture.countAgentRuns(), 0);
});

test('send timeout retries the frozen proposal without another model run', async () => {
  const fixture = setupBridge();
  const send = fixture.bridge.mail.send;
  let loseNextResponse = true;

  fixture.bridge.mail.send = async (...args) => {
    const result = await send(...args);
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new Error('lost response');
    }
    return result;
  };

  await assert.rejects(fixture.bridge.receive(customerEmail()));
  await fixture.bridge.receive(customerEmail());
  assert.equal(fixture.countAgentRuns(), 1);
  assert.equal(fixture.sentEmails.length, 1);
});

test('large attachments stay out of 64 KiB Memories and are rehydrated after a retry', async () => {
  const fixture = setupBridge();
  const email = customerEmail();
  const bytes = Buffer.alloc(120_000, 65);
  email.parsed.attachments = [
    {
      filename: 'sample-image.png',
      content_type: 'image/png',
      part_index: 0,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ];
  fixture.bridge.mail.attachment = async () => bytes;

  const put = fixture.bridge.store.put;
  fixture.bridge.store.put = async (key, value, condition) => {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 65_536);
    return put(key, value, condition);
  };

  let attempts = 0;
  const invoke = fixture.bridge.invoke;
  fixture.bridge.invoke = async (event) => {
    const attachment = event.email.attachments[0];
    assert.equal(
      Buffer.from(attachment.content_base64, 'base64').length,
      bytes.length,
    );
    if (attempts++ === 0) throw new Error('temporary agent outage');
    return invoke(event);
  };

  await assert.rejects(fixture.bridge.receive(email), /temporary agent outage/);
  const checkpoint = fixture.memories.get('event/' + email.id);
  assert.equal(checkpoint.event.email.attachments[0].content_base64, undefined);

  await fixture.bridge.receive(email);
  assert.equal(fixture.sentEmails.length, 1);
});

test('customer routing is independent of the human approver', async () => {
  const fixture = setupBridge();
  fixture.bridge.config = {
    ...config,
    allowed_customers: ['customer@gmail.com'],
  };
  const email = customerEmail();
  email.from_email = 'customer@gmail.com';
  await fixture.bridge.receive(email);
  const permission = JSON.parse(fixture.sentEmails[0].body.body_text);
  assert.equal(permission.action.to, 'customer@gmail.com');
  assert.notEqual(permission.action.to, config.approver);
});

test('queued follow-ups cannot replace the customer context bound to an approval', async () => {
  const fixture = setupBridge();
  const initial = await fixture.bridge.receive(customerEmail());
  const followUp = customerEmail();
  followUp.id = crypto.randomUUID();
  followUp.message_id = '<followup@gmail.com>';
  followUp.parsed.body_text = 'New information';
  await fixture.bridge.createCustomerEvent(followUp);
  const receipt = customerEmail();
  receipt.id = crypto.randomUUID();
  receipt.recipient = config.requester_address;
  receipt.from_email = config.approval_address;
  receipt.auth.dkimSignatures = [
    {
      domain: config.signing_domain,
      selector: config.signing_selector,
      result: 'pass',
      aligned: true,
    },
  ];
  receipt.parsed.body_text = JSON.stringify({
    protocol: 'permission.receipt/1',
    request_id: initial.permission_id,
    client_request_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    status: 'changes_requested',
  });
  const event = await fixture.bridge.createReceiptEvent(receipt);
  assert.equal(event.email.message_id, '<customer@gmail.com>');
  assert.equal(event.email.body_text, 'What is missing?');
});

test("a known customer cannot join another customer's conversation", async () => {
  const fixture = setupBridge();
  fixture.bridge.config.allowed_customers = [
    config.approver,
    'other@gmail.com',
  ];
  await fixture.bridge.receive(customerEmail());
  const other = customerEmail();
  other.id = crypto.randomUUID();
  other.from_email = 'other@gmail.com';
  await assert.rejects(
    fixture.bridge.receive(other),
    /conversation_customer_mismatch/,
  );
  assert.equal(fixture.countAgentRuns(), 1);
});
