import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalService, publicRecord } from './service.mjs';
import { sha } from '../shared/crypto.mjs';
import { actionHash } from './action.mjs';
import { canonical } from '../shared/json.mjs';
import { parseApprovalCommand as command } from './commands.mjs';
import { authenticated } from '../integrations/primitive/authentication.mjs';
import { verifySignature } from '../integrations/primitive/signature.mjs';
const config = {
  approver: 'owner@gmail.com',
  allowed_recipients: ['owner@gmail.com'],
  requester_address: 'requester@demo.primitive.email',
  approval_address: 'approvals@demo.primitive.email',
  execution_address: 'executor@demo.primitive.email',
  customer_sender: 'support@demo.primitive.email',
  signing_domain: 'primitive.email',
  signing_selector: 'demo.pri-abc',
};
function setup() {
  let now = 100000000;
  const records = new Map();
  const sent = [];
  const attachments = new Map();
  let wakes = 0;
  const store = {
    async get(id) {
      return structuredClone(records.get(id) || null);
    },
    async put(id, value, condition) {
      const old = records.get(id);
      if (
        (condition.if_absent && old) ||
        (condition.if_version && old?.version !== condition.if_version)
      ) {
        const message = new Error('conflict');
        message.status = 409;
        throw message;
      }
      const memory = {
        value: canonical(structuredClone(value)),
        version: String(Number(old?.version || 0) + 1),
      };
      records.set(id, memory);
      return structuredClone(memory);
    },
  };
  const mail = {
    base64: (b) => Buffer.from(b).toString('base64'),
    attachment: async (id, index) => attachments.get(id + ':' + index),
    send: async (body, key) => {
      const row = { body, key, id: crypto.randomUUID(), status: 'delivered' };
      sent.push(row);
      return row;
    },
    lookup: async (key) => sent.filter((fixture) => fixture.key === key),
    detail: async (id) => sent.find((fixture) => fixture.id === id),
    wake: async (args, id) => {
      wakes++;
      return {
        wire_id: 'wire@demo.primitive.email',
        step_id: 'step',
        send_id: 'send',
        interaction_id: 'interaction',
      };
    },
  };
  const service = new ApprovalService({
    store,
    mail,
    config,
    now: () => now,
    assess: async () => ({ source: 'jev', choice: 'review' }),
  });
  function email(from, recipient, body, id = crypto.randomUUID()) {
    return {
      id,
      from_email: from,
      recipient,
      body_text: body,
      message_id: `<${id}@test>`,
      received_at: new Date(now).toISOString(),
      status: 'completed',
      parsed: { status: 'complete', body_text: body, attachments: [] },
      auth: {
        dmarc: 'pass',
        dmarcDkimAligned: true,
        dkimSignatures: [
          {
            domain: from.endsWith('@gmail.com')
              ? 'gmail.com'
              : config.signing_domain,
            selector: config.signing_selector,
            result: 'pass',
            aligned: true,
          },
        ],
      },
    };
  }
  async function propose() {
    const message = email(
      config.requester_address,
      config.approval_address,
      JSON.stringify({
        protocol: 'permission.request/1',
        request_id: crypto.randomUUID(),
        created_at: new Date(now).toISOString(),
        action: {
          type: 'email.send',
          to: config.approver,
          subject: 'Order 1042',
          body_text: 'Please upload a note.',
        },
      }),
    );
    await service.handleEmail(message);
    return [...records.values()][0].value;
  }
  async function approve(record) {
    const message = email(
      config.approver,
      config.approval_address,
      `APPROVE ${record.id}`,
    );
    message.reply_to_sent_email_id = (
      await service.record(record.id)
    ).notification.provider_id;
    await service.handleEmail(message);
    return message;
  }
  async function wake(record, override = {}) {
    record = await service.record(record.id);
    const envelope = {
      interaction_version: 1,
      protocol: 'wake.dispatch',
      protocol_version: 1,
      step: 'dispatch',
      interaction_id: record.wake.wire_id,
      step_id: record.wake.step_id,
      payload: {
        command: 'resume_request',
        args: {
          request_id: record.id,
          action_hash: record.hash,
          nonce: record.wake.token,
          ...override,
        },
      },
    };
    const message = email(
      config.approval_address,
      config.execution_address,
      'Wake',
    );
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    message.message_id = '<primitive-direct-send@primitive.email>';
    message.parsed.attachments = [
      {
        filename: 'interaction.json',
        part_index: 0,
        size_bytes: bytes.length,
        sha256: await sha(bytes),
      },
    ];
    attachments.set(message.id + ':0', bytes);
    return message;
  }
  return {
    service,
    records,
    sent,
    mail,
    attachments,
    email,
    propose,
    approve,
    wake,
    now: (v) => (now = v),
    wakes: () => wakes,
  };
}
test('email request -> human reply -> native Wake -> one exact send and agent receipt', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  assert.equal(record.status, 'pending');
  assert.equal(
    fixture.sent.filter((updatedRecord) =>
      updatedRecord.key.startsWith('hosted:execute'),
    ).length,
    0,
  );
  await fixture.approve(record);
  assert.equal(fixture.wakes(), 1);
  await fixture.service.handleEmail(await fixture.wake(record));
  assert.equal((await fixture.service.record(record.id)).status, 'executed');
  const send = fixture.sent.find(
    (updatedRecord) => updatedRecord.key === `hosted:execute:${record.id}`,
  );
  assert.equal(send.body.body_text, record.action.body_text);
  assert.equal(send.body.to, config.approver);
  assert.ok(
    fixture.sent.find(
      (updatedRecord) =>
        updatedRecord.key === `hosted:receipt:final:${record.id}:executed`,
    ),
  );
  assert.equal(
    publicRecord(await fixture.service.record(record.id)).approval_code,
    undefined,
  );
});
test('concurrent duplicate Wake delivery consumes permission only once', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  await fixture.approve(record);
  const message = await fixture.wake(record);
  await Promise.all([
    fixture.service.handleEmail(message),
    fixture.service.handleEmail(message),
    fixture.service.handleEmail(message),
  ]);
  assert.equal(
    fixture.sent.filter((updatedRecord) =>
      updatedRecord.key.startsWith('hosted:execute'),
    ).length,
    1,
  );
  assert.equal(
    (await fixture.service.record(record.id)).events.filter(
      (updatedRecord) => updatedRecord.kind === 'execution_delivery',
    ).length,
    1,
  );
});
test('duplicate human reply never creates a second Wake', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  const message = await fixture.approve(record);
  await fixture.service.handleEmail(message);
  assert.equal(fixture.wakes(), 1);
});
test('forwarded or unauthenticated approvals and wrong request token are refused', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  for (const mode of ['from', 'auth', 'code']) {
    const message = fixture.email(
      config.approver,
      config.approval_address,
      `APPROVE ${record.id} ${'F'.repeat(32)}`,
    );
    if (mode === 'from') {
      message.from_email = 'evil@gmail.com';
    }
    if (mode === 'auth') {
      message.auth.dmarc = 'fail';
    }
    await assert.rejects(fixture.service.handleEmail(message));
  }
  assert.equal((await fixture.service.record(record.id)).status, 'pending');
});
test('managed signer must match this account selector', () => {
  const fixture = setup();
  const message = fixture.email(
    config.requester_address,
    config.approval_address,
    'x',
  );
  assert.ok(authenticated(message, config.requester_address, config));
  message.auth.dkimSignatures[0].selector = 'someone-else';
  assert.ok(!authenticated(message, config.requester_address, config));
});
test('strict commands do not interpret conditional approvals or quoted text', () => {
  assert.equal(
    command('APPROVE A8CBC8B28FC74175 if you change the body'),
    null,
  );
  assert.equal(command('> APPROVE A8CBC8B28FC74175'), null);
  assert.equal(command('APPROVE A8CBC8B28FC74175\nbut change this'), null);
  assert.equal(
    command('APPROVE A8CBC8B28FC74175\n\nOn Saturday, Jerry wrote:\nquoted')
      .decision,
    'APPROVE',
  );
});
test('altered content, mismatched hash, expiry, revocation, and forged Wake all fail closed', async () => {
  for (const mode of ['content', 'hash', 'expiry', 'revoke', 'nonce']) {
    const fixture = setup();
    const record = await fixture.propose();
    await fixture.approve(record);
    let message = await fixture.wake(
      record,
      mode === 'hash'
        ? { action_hash: 'wrong' }
        : mode === 'nonce'
          ? { nonce: 'wrong' }
          : {},
    );
    if (mode === 'content') {
      fixture.records.get(record.id).value.action.body_text = 'altered';
    }
    if (mode === 'expiry') {
      fixture.now(record.expires_at + 1);
    }
    if (mode === 'revoke') {
      await fixture.service.edit(record.id, (updatedRecord) => {
        updatedRecord.status = 'revoked';
        return true;
      });
    }
    await assert.rejects(fixture.service.handleEmail(message));
    assert.equal(
      fixture.sent.filter((updatedRecord) =>
        updatedRecord.key.startsWith('hosted:execute'),
      ).length,
      0,
    );
  }
});
test('send timeout cannot cause an automatic resend', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  await fixture.approve(record);
  const original = fixture.mail.send;
  let attempts = 0;
  fixture.mail.send = async (b, k) => {
    if (k.startsWith('hosted:execute')) {
      attempts++;
      throw new Error('timeout');
    }
    return original(b, k);
  };
  const message = await fixture.wake(record);
  await fixture.service.handleEmail(message);
  await fixture.service.handleEmail(message);
  assert.equal(attempts, 1);
  assert.equal(
    (await fixture.service.record(record.id)).status,
    'execution_unknown',
  );
});
test('attachment changed after approval blocks execution', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  const bytes = new TextEncoder().encode('approved');
  await fixture.service.edit(record.id, (updatedRecord) => {
    updatedRecord.action.attachments = [
      {
        filename: 'note.txt',
        content_type: 'text/plain',
        size_bytes: bytes.length,
        sha256: 'x',
        part_index: 0,
      },
    ];
    return true;
  });
  let updatedRecord = await fixture.service.record(record.id);
  updatedRecord.action.attachments[0].sha256 = await sha(bytes);
  updatedRecord.hash = await actionHash(updatedRecord.action);
  fixture.records.get(record.id).value = updatedRecord;
  await fixture.approve(updatedRecord);
  fixture.attachments.set(
    updatedRecord.source_email_id + ':0',
    new TextEncoder().encode('tampered'),
  );
  await assert.rejects(
    fixture.service.handleEmail(await fixture.wake(updatedRecord)),
    /attachment_changed/,
  );
  assert.equal(
    fixture.sent.filter((updatedRecord) =>
      updatedRecord.key.startsWith('hosted:execute'),
    ).length,
    0,
  );
});
test('signed webhook rejects tampering, stale timestamp and missing secret', async () => {
  const raw = '{"event":"email.received"}';
  const secret = 'test-secret';
  const now = 100000000;
  const t = now / 1000;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = Buffer.from(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${t}.${raw}`),
    ),
  ).toString('hex');
  assert.ok(await verifySignature(raw, `t=${t},v1=${sig}`, secret, now));
  assert.equal(
    await verifySignature(raw + ' ', `t=${t},v1=${sig}`, secret, now),
    false,
  );
  assert.equal(
    await verifySignature(raw, `t=${t},v1=${sig}`, secret, now + 301000),
    false,
  );
  assert.equal(await verifySignature(raw, `t=${t},v1=${sig}`, '', now), false);
});

test('memory JSON key reordering preserves exact action fingerprint', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  const original = record.hash;
  const reorder = (updatedRecord) =>
    Array.isArray(updatedRecord)
      ? updatedRecord.map(reorder)
      : updatedRecord && typeof updatedRecord === 'object'
        ? Object.fromEntries(
            Object.keys(updatedRecord)
              .sort()
              .map((k) => [k, reorder(updatedRecord[k])]),
          )
        : updatedRecord;
  fixture.records.get(record.id).value = reorder(
    fixture.records.get(record.id).value,
  );
  assert.equal(
    await actionHash((await fixture.service.record(record.id)).action),
    original,
  );
  await fixture.approve(record);
  await fixture.service.handleEmail(await fixture.wake(record));
  assert.equal((await fixture.service.record(record.id)).status, 'executed');
});

test('concurrent Wake cannot issue a premature final receipt', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  await fixture.approve(record);
  const original = fixture.mail.send;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  fixture.mail.send = async (b, k) => {
    if (k.startsWith('hosted:execute')) {
      await gate;
    }
    return original(b, k);
  };
  const message = await fixture.wake(record);
  const first = fixture.service.handleEmail(message);
  while (
    (await fixture.service.record(record.id)).execution.state !== 'sending'
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await fixture.service.handleEmail(message);
  assert.equal(
    fixture.sent.filter((updatedRecord) =>
      updatedRecord.key.startsWith('hosted:receipt:final'),
    ).length,
    0,
  );
  release();
  await first;
  const final = fixture.sent.filter((updatedRecord) =>
    updatedRecord.key.startsWith('hosted:receipt:final'),
  );
  assert.equal(final.length, 1);
  assert.equal(JSON.parse(final[0].body.body_text).status, 'executed');
});
test('early approval delivery is retryable until notification persistence completes', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  await fixture.service.edit(record.id, (updatedRecord) => {
    updatedRecord.notification = { state: 'sending' };
    return true;
  });
  const message = fixture.email(
    config.approver,
    config.approval_address,
    `APPROVE ${record.id}`,
  );
  await assert.rejects(fixture.service.handleEmail(message), {
    name: 'Error',
    message: 'notification_not_recorded',
  });
  assert.equal((await fixture.service.record(record.id)).status, 'pending');
});

test('CHANGE receipt carries feedback and client correlation for agent resumption', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  const message = fixture.email(
    config.approver,
    config.approval_address,
    `CHANGE ${record.id}\nMake this shorter.`,
  );
  message.reply_to_sent_email_id = record.notification.provider_id;
  await fixture.service.handleEmail(message);
  const receipt = JSON.parse(
    fixture.sent.find(
      (updatedRecord) =>
        updatedRecord.key ===
        `hosted:receipt:final:${record.id}:changes_requested`,
    ).body.body_text,
  );
  assert.equal(receipt.feedback, 'Make this shorter.');
  assert.equal(receipt.client_request_id, record.client_id);
  assert.equal(receipt.status, 'changes_requested');
  assert.equal(fixture.wakes(), 0);
});
test('customer reply threading is bound into the permission fingerprint', async () => {
  const fixture = setup();
  const record = await fixture.propose();
  const a = { ...record.action, in_reply_to: '<customer@gmail.com>' };
  assert.notEqual(
    await actionHash(a),
    await actionHash({ ...a, in_reply_to: '<other@gmail.com>' }),
  );
  assert.notEqual(await actionHash(a), await actionHash(record.action));
});

test('recipient permissions are configured independently from the human approver', async () => {
  const fixture = setup();
  fixture.service.config = {
    ...config,
    allowed_recipients: ['customer@example.com'],
  };
  const makeRequest = (to) =>
    fixture.email(
      config.requester_address,
      config.approval_address,
      JSON.stringify({
        protocol: 'permission.request/1',
        request_id: crypto.randomUUID(),
        created_at: new Date(100000000).toISOString(),
        action: {
          type: 'email.send',
          to,
          subject: 'Customer support',
          body_text: 'A proposed reply.',
        },
      }),
    );
  await assert.rejects(
    fixture.service.handleEmail(makeRequest(config.approver)),
    /recipient_not_allowed/,
  );
  const result = await fixture.service.handleEmail(
    makeRequest('customer@example.com'),
  );
  assert.equal(result.status, 'pending');
  assert.equal(
    fixture.sent.find((email) => email.body.to === config.approver).body.to,
    config.approver,
  );
  assert.equal(
    [...fixture.records.values()][0].value.action.to,
    'customer@example.com',
  );
});

test('review-only files reach the approver but are excluded from the approved customer send', async () => {
  const fixture = setup();
  const bytes = new TextEncoder().encode('private review evidence');
  const message = fixture.email(
    config.requester_address,
    config.approval_address,
    JSON.stringify({
      protocol: 'permission.request/1',
      request_id: crypto.randomUUID(),
      created_at: new Date(100000000).toISOString(),
      context: { output_attachment_count: 0 },
      action: {
        type: 'email.send',
        to: config.approver,
        subject: 'Re: Intake',
        body_text: 'Thank you for sending your information.',
      },
    }),
  );
  message.parsed.attachments = [
    {
      filename: 'review.txt',
      content_type: 'text/plain',
      part_index: 0,
      size_bytes: bytes.length,
      sha256: await sha(bytes),
    },
  ];
  fixture.attachments.set(message.id + ':0', bytes);
  const record = await fixture.service.handleEmail(message);
  const notification = fixture.sent.find(
    (row) => row.body.to === config.approver,
  );
  assert.equal(notification.body.attachments.length, 1);
  assert.ok(
    notification.body.body_text.includes('will not be sent to the customer'),
  );
  await fixture.approve(record);
  await fixture.service.handleEmail(await fixture.wake(record));
  const execution = fixture.sent.find(
    (row) => row.body.from === config.customer_sender,
  );
  assert.equal(execution.body.attachments.length, 0);
});
