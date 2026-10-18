import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import sourceWorker from './inbox.mjs';
import { buildInboxBundle } from '../../scripts/lib/bundles.mjs';

// Exercise the upload artifact too: missing imports or different error-class
// identities in a bundle must not change webhook authentication or retries.
await buildInboxBundle();
const { default: bundledWorker } = await import('../../dist/inbox.mjs');

const config = {
  approver: 'owner@gmail.com',
  allowed_customers: ['owner@gmail.com'],
  requester_address: 'requester@demo.primitive.email',
  approval_address: 'approvals@demo.primitive.email',
  customer_sender: 'support@demo.primitive.email',
  signing_domain: 'primitive.email',
  signing_selector: 'demo.pri-abc',
  agent_url: 'https://agent.example.test',
};

const env = {
  PRIMITIVE_API_KEY: 'test-primitive-key',
  PRIMITIVE_FUNCTION_ID: 'test-function-id',
  PRIMITIVE_WEBHOOK_SECRET: 'test-webhook-secret',
  AGENT_BRIDGE_SECRET: 'test-agent-secret',
  INBOX_CONFIG: JSON.stringify(config),
};

function customerEmail() {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    thread_id: 'customer-thread',
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

function webhook(
  emailId,
  { eventType = 'email.received', timestamp, signature } = {},
) {
  const body = JSON.stringify({ email: { id: emailId } });
  timestamp ??= String(Math.floor(Date.now() / 1000));
  signature ??= createHmac('sha256', env.PRIMITIVE_WEBHOOK_SECRET)
    .update(timestamp + '.' + body)
    .digest('hex');

  return new Request('https://inbox.example.test', {
    method: 'POST',
    headers: {
      'Primitive-Signature': `t=${timestamp},v1=${signature}`,
      'X-Webhook-Event': eventType,
    },
    body,
  });
}

function setupServices(context) {
  const emails = new Map();
  const memories = new Map();
  const sentEmails = [];
  const agentEvents = [];
  const services = {
    emails,
    memories,
    sentEmails,
    agentEvents,
    unavailable: false,
  };

  context.mock.method(console, 'log', () => {});
  const fetchMock = context.mock.method(
    globalThis,
    'fetch',
    async (url, options = {}) => {
      if (services.unavailable) return Response.json({}, { status: 503 });

      if (url === config.agent_url + '/events') {
        const header = options.headers['X-Agent-Signature'];
        const [, timestamp, signature] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(
          header,
        );
        const expectedSignature = createHmac('sha256', env.AGENT_BRIDGE_SECRET)
          .update(timestamp + '.' + options.body)
          .digest('hex');
        assert.equal(signature, expectedSignature);

        const event = JSON.parse(options.body);
        agentEvents.push(event);
        return Response.json({
          conversation_id: event.conversation_id,
          session_id: 'saved-claude-session',
          resumed: event.kind === 'receipt',
          status:
            event.kind === 'receipt'
              ? event.receipt.status
              : 'waiting_for_approval',
          tool_calls:
            event.kind === 'receipt' ? [] : ['read_order', 'send_email'],
          cost_usd: 0.01,
          ...(event.kind === 'customer'
            ? {
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
              }
            : {}),
        });
      }

      const endpoint = new URL(url);
      assert.equal(endpoint.origin, 'https://api.primitive.dev');
      assert.equal(
        options.headers.Authorization,
        'Bearer ' + env.PRIMITIVE_API_KEY,
      );
      assert.equal(
        options.headers['x-primitive-function-id'],
        env.PRIMITIVE_FUNCTION_ID,
      );

      if (endpoint.pathname.startsWith('/v1/emails/')) {
        const emailId = endpoint.pathname.split('/').at(-1);
        assert.ok(
          emails.has(emailId),
          'The test must provide the requested email.',
        );
        return Response.json({ success: true, data: emails.get(emailId) });
      }

      if (endpoint.pathname === '/v1/memories' && options.method === 'GET') {
        const key = endpoint.searchParams.get('key');
        return memories.has(key)
          ? Response.json({ success: true, data: { value: memories.get(key) } })
          : Response.json({ success: false }, { status: 404 });
      }

      if (endpoint.pathname === '/v1/memories' && options.method === 'PUT') {
        const { key, value, if_absent } = JSON.parse(options.body);
        assert.ok(Buffer.byteLength(JSON.stringify(value)) < 65_536);

        if (if_absent && memories.has(key)) {
          return Response.json({ success: false }, { status: 409 });
        }

        memories.set(key, value);
        return Response.json({ success: true, data: { value } });
      }

      if (endpoint.pathname === '/v1/send-mail') {
        const key = options.headers['Idempotency-Key'];
        let sent = sentEmails.find((email) => email.key === key);

        if (!sent) {
          sent = {
            id: 'permission-email-' + (sentEmails.length + 1),
            status: 'delivered',
            key,
            payload: JSON.parse(options.body),
          };
          sentEmails.push(sent);
        }

        return Response.json({
          success: true,
          data: { id: sent.id, status: sent.status },
        });
      }

      throw new Error('Unexpected test endpoint: ' + endpoint.pathname);
    },
  );

  return { ...services, state: services, fetchMock };
}

for (const [name, worker] of [
  ['source', sourceWorker],
  ['bundle', bundledWorker],
]) {
  test(name + ' worker', async (context) => {
    await context.test(
      'customer email, replay, and completion receipt preserve one conversation',
      async (context) => {
        const services = setupServices(context);
        const customer = customerEmail();
        services.emails.set(customer.id, customer);

        const initialResponse = await worker.fetch(webhook(customer.id), env);
        assert.equal(initialResponse.status, 200);
        const initial = await initialResponse.json();
        assert.equal(initial.status, 'waiting_for_approval');
        assert.equal(services.agentEvents.length, 1);
        assert.equal(services.sentEmails.length, 1);

        const permissionEmail = services.sentEmails[0].payload;
        const permission = JSON.parse(permissionEmail.body_text);
        assert.equal(permissionEmail.from, config.requester_address);
        assert.equal(permissionEmail.to, config.approval_address);
        assert.equal(permission.action.to, config.approver);
        assert.equal(permission.action.in_reply_to, customer.message_id);
        assert.equal(permission.protocol, 'permission.request/1');
        assert.equal(permissionEmail.attachments[0].filename, 'context.txt');

        const replay = await worker.fetch(webhook(customer.id), env);
        assert.equal((await replay.json()).replayed, true);
        assert.equal(services.agentEvents.length, 1);
        assert.equal(services.sentEmails.length, 1);

        const receiptEmail = {
          ...customer,
          id: '22222222-2222-4222-a222-222222222222',
          recipient: config.requester_address,
          from_email: config.approval_address,
          auth: {
            dmarc: 'pass',
            dmarcDkimAligned: true,
            dkimSignatures: [
              {
                domain: config.signing_domain,
                selector: config.signing_selector,
                aligned: true,
                result: 'pass',
              },
            ],
          },
          parsed: {
            status: 'complete',
            attachments: [],
            body_text: JSON.stringify({
              protocol: 'permission.receipt/1',
              request_id: initial.permission_id,
              client_request_id: permission.request_id,
              status: 'executed',
              execution: { provider_id: 'delivered-customer-email' },
            }),
          },
        };
        services.emails.set(receiptEmail.id, receiptEmail);

        const completion = await worker.fetch(webhook(receiptEmail.id), env);
        const completed = await completion.json();
        assert.equal(completed.status, 'executed');
        assert.equal(completed.session_id, initial.session_id);
        assert.equal(completed.resumed, true);
        assert.equal(
          services.agentEvents[1].conversation_id,
          initial.conversation_id,
        );
        assert.equal(services.agentEvents[1].receipt.status, 'executed');
        assert.equal(services.sentEmails.length, 1);
        assert.deepEqual(
          services.memories.get('inbox/sent/delivered-customer-email'),
          {
            conversation_id: initial.conversation_id,
          },
        );

        await worker.fetch(webhook(receiptEmail.id), env);
        assert.equal(services.agentEvents.length, 2);
        assert.equal(services.sentEmails.length, 1);
      },
    );

    await context.test(
      'forged and stale webhook signatures are rejected before any API call',
      async (context) => {
        const services = setupServices(context);
        const emailId = customerEmail().id;

        for (const options of [
          { signature: '0'.repeat(64) },
          { timestamp: String(Math.floor(Date.now() / 1000) - 600) },
        ]) {
          const response = await worker.fetch(webhook(emailId, options), env);
          assert.equal(response.status, 401);
        }

        assert.equal(services.fetchMock.mock.callCount(), 0);
      },
    );

    await context.test(
      'unrelated signed events are acknowledged without invoking the agent',
      async (context) => {
        const services = setupServices(context);
        const response = await worker.fetch(
          webhook(customerEmail().id, { eventType: 'email.delivered' }),
          env,
        );
        assert.deepEqual(await response.json(), { ok: true, ignored: true });
        assert.equal(services.fetchMock.mock.callCount(), 0);
      },
    );

    await context.test(
      'invalid email IDs are rejected without a retry or API call',
      async (context) => {
        const services = setupServices(context);
        const response = await worker.fetch(webhook('invalid-email-id'), env);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          ok: true,
          rejected: 'invalid_email_id',
        });
        assert.equal(services.fetchMock.mock.callCount(), 0);
      },
    );

    await context.test(
      'unauthenticated customer email is rejected without starting the agent',
      async (context) => {
        const services = setupServices(context);
        const email = customerEmail();
        email.auth.dmarc = 'fail';
        services.emails.set(email.id, email);

        const response = await worker.fetch(webhook(email.id), env);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          ok: true,
          rejected: 'untrusted_customer',
        });
        assert.equal(services.agentEvents.length, 0);
        assert.equal(services.sentEmails.length, 0);
      },
    );

    await context.test(
      'provider failures request a retry instead of acknowledging completion',
      async (context) => {
        const services = setupServices(context);
        services.state.unavailable = true;

        const response = await worker.fetch(webhook(customerEmail().id), env);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false, retry: true });
        assert.equal(services.agentEvents.length, 0);
        assert.equal(services.sentEmails.length, 0);
      },
    );
  });
}

for (const [index, worker] of [sourceWorker, bundledWorker].entries()) {
  test(
    'malformed signed JSON is rejected before provider calls, worker ' + index,
    async (context) => {
      context.mock.method(console, 'log', () => {});
      context.mock.method(globalThis, 'fetch', () =>
        assert.fail('must not call a provider'),
      );
      const body = '{';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', env.PRIMITIVE_WEBHOOK_SECRET)
        .update(timestamp + '.' + body)
        .digest('hex');
      const response = await worker.fetch(
        new Request('https://worker.example.test', {
          method: 'POST',
          body,
          headers: {
            'X-Webhook-Event': 'email.received',
            'Primitive-Signature': `t=${timestamp},v1=${signature}`,
          },
        }),
        env,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        rejected: 'invalid_event_json',
      });
    },
  );
}
