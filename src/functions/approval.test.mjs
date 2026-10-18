import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import sourceWorker from './approval.mjs';
import { buildApprovalBundle } from '../../scripts/lib/bundles.mjs';
import { sha } from '../shared/crypto.mjs';

await buildApprovalBundle();
const { default: bundledWorker } = await import('../../dist/approval.mjs');

const config = {
  approver: 'owner@gmail.com',
  order_id: '1042',
  teammates: { optician: 'owner@gmail.com' },
  allowed_recipients: ['owner@gmail.com'],
  requester_address: 'requester@demo.primitive.email',
  approval_address: 'approvals@demo.primitive.email',
  execution_address: 'executor@demo.primitive.email',
  customer_sender: 'support@demo.primitive.email',
  signing_domain: 'primitive.email',
  signing_selector: 'demo.pri-abc',
};
const env = {
  PRIMITIVE_API_KEY: 'test-primitive-key',
  PRIMITIVE_FUNCTION_ID: 'test-function',
  PRIMITIVE_WEBHOOK_SECRET: 'test-webhook-secret',
  TYPESAFE_API_KEY: 'test-jev-key',
  APPROVAL_CONFIG: JSON.stringify(config),
};

function email(from, recipient, body) {
  const id = crypto.randomUUID();
  return {
    id,
    from_email: from,
    recipient,
    subject: 'Request',
    message_id: `<${id}@test>`,
    received_at: new Date().toISOString(),
    status: 'completed',
    parsed: { status: 'complete', body_text: body, attachments: [] },
    auth: {
      dmarc: 'pass',
      dmarcDkimAligned: true,
      dkimSignatures: [
        {
          domain:
            from === config.approver ? 'gmail.com' : config.signing_domain,
          selector: config.signing_selector,
          aligned: true,
          result: 'pass',
        },
      ],
    },
  };
}

function webhook(emailId) {
  const body = JSON.stringify({ email: { id: emailId } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', env.PRIMITIVE_WEBHOOK_SECRET)
    .update(timestamp + '.' + body)
    .digest('hex');
  return new Request('https://approval.example.test', {
    method: 'POST',
    body,
    headers: {
      'Primitive-Signature': `t=${timestamp},v1=${signature}`,
      'X-Webhook-Event': 'email.received',
    },
  });
}

function setupServices(context, decision = 'review') {
  const emails = new Map();
  const memories = new Map();
  const sent = [];
  const attachmentBytes = new Map();
  const wakeOperations = [];
  let wakeArgs;
  context.mock.method(console, 'log', () => {});

  const fetchMock = context.mock.method(
    globalThis,
    'fetch',
    async (url, options = {}) => {
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        const assessment = JSON.parse(options.body);
        assert.equal(assessment.model, 'jev-latest');
        return Response.json({
          model: 'test-jev',
          answers: { route: { choice: decision, confidence: 0.99 } },
        });
      }

      const endpoint = new URL(url);
      assert.equal(endpoint.origin, 'https://api.primitive.dev');
      assert.equal(
        options.headers.Authorization,
        'Bearer ' + env.PRIMITIVE_API_KEY,
      );
      const body = options.body ? JSON.parse(options.body) : null;
      const success = (data) => Response.json({ success: true, data });

      if (endpoint.pathname.startsWith('/v1/emails/')) {
        if (endpoint.pathname.endsWith('/attachments/0')) {
          return new Response(
            attachmentBytes.get(endpoint.pathname.split('/')[3]),
          );
        }
        return success(emails.get(endpoint.pathname.split('/').at(-1)));
      }

      if (endpoint.pathname === '/v1/memories') {
        if (options.method === 'GET') {
          const record = memories.get(endpoint.searchParams.get('key'));
          return record
            ? success(record)
            : Response.json({ success: false }, { status: 404 });
        }
        const previous = memories.get(body.key);
        if (
          (body.if_absent && previous) ||
          (body.if_version && body.if_version !== previous?.version)
        ) {
          return Response.json({ success: false }, { status: 409 });
        }
        const record = {
          value: body.value,
          version: String(Number(previous?.version || 0) + 1),
        };
        memories.set(body.key, record);
        return success(record);
      }

      if (endpoint.pathname === '/v1/send-mail') {
        const key = options.headers['Idempotency-Key'];
        let message = sent.find((entry) => entry.key === key);
        if (!message) {
          message = { id: crypto.randomUUID(), status: 'delivered', body, key };
          sent.push(message);
        }
        return success({ id: message.id, status: message.status });
      }

      if (endpoint.pathname.startsWith('/v1/wake/schedules')) {
        wakeOperations.push({
          method: options.method,
          path: endpoint.pathname,
        });
        if (endpoint.pathname === '/v1/wake/schedules') {
          wakeArgs = body.args;
          return success({ id: 'schedule-1' });
        }
        if (endpoint.pathname.endsWith('/run')) {
          return success({
            wire_id: 'wire-1',
            step_id: 'step-1',
            send_id: 'send-1',
          });
        }
        return success({});
      }

      if (endpoint.pathname === '/v1/sent-emails') {
        return success(
          sent.filter(
            (message) =>
              message.key === endpoint.searchParams.get('idempotency_key'),
          ),
        );
      }
      if (endpoint.pathname.startsWith('/v1/sent-emails/')) {
        return success(
          sent.find(
            (message) => message.id === endpoint.pathname.split('/').at(-1),
          ),
        );
      }
      throw new Error('Unexpected test endpoint: ' + endpoint.pathname);
    },
  );

  return {
    emails,
    memories,
    sent,
    wakeOperations,
    fetchMock,
    async propose(worker) {
      const request = email(
        config.requester_address,
        config.approval_address,
        JSON.stringify({
          protocol: 'permission.request/1',
          request_id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          action: {
            type: 'email.send',
            to: config.approver,
            subject: 'Order 1042',
            body_text: 'Please send a prescription image and PD.',
          },
        }),
      );
      emails.set(request.id, request);
      const response = await worker.fetch(webhook(request.id), env);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.ok(result.request_id, JSON.stringify(result));
      return result;
    },
    async createWakeEmail() {
      const wake = email(
        config.approval_address,
        config.execution_address,
        'Wake',
      );
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          interaction_version: 1,
          protocol: 'wake.dispatch',
          protocol_version: 1,
          step: 'dispatch',
          interaction_id: 'wire-1',
          step_id: 'step-1',
          payload: { command: 'resume_request', args: wakeArgs },
        }),
      );
      wake.message_id = '<primitive-direct-send-1@primitive.email>';
      wake.parsed.attachments = [
        {
          filename: 'interaction.json',
          part_index: 0,
          size_bytes: bytes.length,
          sha256: await sha(bytes),
        },
      ];
      attachmentBytes.set(wake.id, bytes);
      emails.set(wake.id, wake);
      return wake;
    },
  };
}

for (const [name, worker] of [
  ['source', sourceWorker],
  ['bundle', bundledWorker],
]) {
  test(name + ' approval worker', async (context) => {
    await context.test(
      'a teammate question and reply use the same deployed inbox without becoming an approval',
      async (context) => {
        const services = setupServices(context, 'allow');
        const request = email(
          config.requester_address,
          config.approval_address,
          JSON.stringify({
            protocol: 'question.request/1',
            request_id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            action: {
              type: 'teammate.question',
              parameters: { role: 'optician' },
              to: config.approver,
              subject: 'Re: My order',
              body_text:
                'Can you check whether the attached document is sufficient?',
            },
          }),
        );
        services.emails.set(request.id, request);
        const response = await worker.fetch(webhook(request.id), env);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, 'pending');
        const notification = services.sent.find(
          (message) => message.body.to === config.approver,
        );
        const reply = email(
          config.approver,
          config.approval_address,
          'Yes, the supplied information is sufficient.',
        );
        reply.subject = 'Re: ' + notification.body.subject;
        reply.reply_to_sent_email_id = notification.id;
        services.emails.set(reply.id, reply);
        const answered = await worker.fetch(webhook(reply.id), env);
        assert.equal((await answered.json()).status, 'answered');
        const receipt = services.sent.find(
          (message) => message.body.to === config.requester_address,
        );
        assert.equal(
          JSON.parse(receipt.body.body_text).protocol,
          'question.receipt/1',
        );
        assert.equal(services.wakeOperations.length, 0);
        assert.equal(
          services.sent.some(
            (message) => message.body.from === config.customer_sender,
          ),
          false,
        );
      },
    );
    await context.test(
      'authenticated approval and Wake deliver one frozen email despite replays',
      async (context) => {
        const services = setupServices(context);
        const initial = await services.propose(worker);
        assert.equal(initial.status, 'pending');
        const record = services.memories.get(
          'approval/' + initial.request_id,
        ).value;
        const humanReply = email(
          config.approver,
          config.approval_address,
          'APPROVE ' + initial.request_id,
        );
        humanReply.reply_to_sent_email_id = record.notification.provider_id;

        const forged = structuredClone(humanReply);
        forged.id = crypto.randomUUID();
        forged.auth.dmarc = 'fail';
        services.emails.set(forged.id, forged);
        const rejected = await worker.fetch(webhook(forged.id), env);
        assert.equal((await rejected.json()).rejected, 'untrusted_approver');
        assert.equal(services.wakeOperations.length, 0);

        services.emails.set(humanReply.id, humanReply);
        await worker.fetch(webhook(humanReply.id), env);
        await worker.fetch(webhook(humanReply.id), env);
        assert.deepEqual(
          services.wakeOperations.map((operation) => operation.method),
          ['POST', 'PATCH', 'POST', 'DELETE'],
        );

        const wake = await services.createWakeEmail();
        const executed = await worker.fetch(webhook(wake.id), env);
        assert.equal((await executed.json()).status, 'executed');
        await worker.fetch(webhook(wake.id), env);

        const customerEmails = services.sent.filter(
          (message) => message.body.from === config.customer_sender,
        );
        assert.equal(customerEmails.length, 1);
        assert.equal(customerEmails[0].body.to, record.action.to);
        assert.equal(customerEmails[0].body.subject, record.action.subject);
        assert.equal(customerEmails[0].body.body_text, record.action.body_text);
        assert.equal(
          services.memories.get('approval/' + initial.request_id).value.hash,
          record.hash,
        );
        const receipts = services.sent.filter(
          (message) => message.body.to === config.requester_address,
        );
        assert.equal(
          JSON.parse(receipts.at(-1).body.body_text).status,
          'executed',
        );
      },
    );

    await context.test(
      'Jev denial blocks both human approval notification and customer delivery',
      async (context) => {
        const services = setupServices(context, 'deny');
        const result = await services.propose(worker);
        assert.equal(result.status, 'blocked');
        assert.equal(
          services.sent.some((message) => message.body.to === config.approver),
          false,
        );
        assert.equal(services.wakeOperations.length, 0);
      },
    );

    await context.test(
      'invalid webhook signatures never reach any external service',
      async (context) => {
        const services = setupServices(context);
        const response = await worker.fetch(
          new Request('https://approval.example.test', {
            method: 'POST',
            body: '{}',
          }),
          env,
        );
        assert.equal(response.status, 401);
        assert.equal(services.fetchMock.mock.callCount(), 0);
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
