import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { createAgentServer } from './http.mjs';

const secret = 'sample-test-secret';

async function setupServer(context, handle, clock) {
  context.mock.method(console, 'log', () => {});
  const server = createAgentServer({
    service: { handle },
    secret,
    modelReady: true,
    clock,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return 'http://127.0.0.1:' + server.address().port;
}

function signedRequest(
  body,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const signature = createHmac('sha256', secret)
    .update(timestamp + '.' + body)
    .digest('hex');
  return {
    method: 'POST',
    body,
    headers: { 'X-Agent-Signature': `t=${timestamp},v1=${signature}` },
  };
}

test('health is public, but unsigned, stale, and altered requests never reach the agent', async (context) => {
  let modelRuns = 0;
  const url = await setupServer(context, async () => {
    modelRuns++;
    return {};
  });
  const health = await fetch(url + '/health');
  assert.deepEqual(await health.json(), {
    ok: true,
    harness: 'claude-agent-sdk',
    model_ready: true,
  });

  const body = JSON.stringify({ id: 'event-1' });
  const tampered = signedRequest(body);
  tampered.body = JSON.stringify({ id: 'different-event' });
  for (const request of [
    { method: 'POST', body },
    signedRequest(body, String(Math.floor(Date.now() / 1000) - 600)),
    tampered,
  ]) {
    assert.equal((await fetch(url + '/events', request)).status, 401);
  }
  assert.equal(modelRuns, 0);
});

test('authenticated events reach the service and return its exact result', async (context) => {
  const event = {
    id: 'event-1',
    kind: 'customer',
    conversation_id: 'conversation-1',
  };
  const result = { status: 'waiting_for_approval', session_id: 'session-1' };
  const url = await setupServer(context, async (received) => {
    assert.deepEqual(received, event);
    return result;
  });
  const response = await fetch(
    url + '/events',
    signedRequest(JSON.stringify(event)),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
});

test('service failures are retryable and unexpected error details are withheld', async (context) => {
  const url = await setupServer(context, async () => {
    throw new Error('private provider detail');
  });
  const response = await fetch(url + '/events', signedRequest('{}'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'agent_unavailable',
    reason: 'harness_error',
  });
});

test('malformed signed JSON is rejected without invoking the service', async (context) => {
  const url = await setupServer(context, () =>
    assert.fail('must not invoke service'),
  );
  const response = await fetch(url + '/events', signedRequest('{'));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_event_json' });
});

test('provider time preserves the freshness window when the VM clock is hours behind', async (context) => {
  const realNow = Date.now();
  context.mock.method(Date, 'now', () => realNow - 2 * 60 * 60 * 1000);
  let runs = 0;
  let synchronizations = 0;
  const url = await setupServer(context, async () => ({ runs: ++runs }), {
    synchronize: async () => synchronizations++,
    now: () => realNow,
  });
  const body = JSON.stringify({ id: 'event-1' });
  assert.equal(
    (
      await fetch(
        url + '/events',
        signedRequest(body, String(Math.floor(realNow / 1000))),
      )
    ).status,
    200,
  );
  for (const timestamp of [realNow - 600000, realNow + 600000]) {
    assert.equal(
      (
        await fetch(
          url + '/events',
          signedRequest(body, String(Math.floor(timestamp / 1000))),
        )
      ).status,
      401,
    );
  }
  assert.equal(runs, 1);
  assert.equal(synchronizations, 3);
});

test('invalid MACs never query the clock and clock failure never starts the agent', async (context) => {
  let synchronizations = 0;
  const url = await setupServer(
    context,
    () => assert.fail('must not invoke service'),
    {
      synchronize: async () => {
        synchronizations++;
        throw new Error('clock_unavailable');
      },
      now: () => assert.fail('must not use an unsynchronized clock'),
    },
  );
  assert.equal(
    (await fetch(url + '/events', { method: 'POST', body: '{}' })).status,
    401,
  );
  assert.equal(synchronizations, 0);
  const response = await fetch(url + '/events', signedRequest('{}'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, 'clock_unavailable');
  assert.equal(synchronizations, 1);
});
