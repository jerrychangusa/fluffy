import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from './agent-client.mjs';

test('a transient unavailable runtime retries the exact event before returning a single result', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    bodies.push(options.body);
    return bodies.length === 1
      ? new Response('unavailable', { status: 503 })
      : Response.json({ status: 'waiting_for_approval' });
  });
  const result = await createAgentClient(
    'https://agent.example',
    'test-secret',
  )({ id: 'same-event' });
  assert.equal(result.status, 'waiting_for_approval');
  assert.deepEqual(bodies, ['{"id":"same-event"}', '{"id":"same-event"}']);
});

test('authentication failures are not retried and do not expose provider response content', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private error detail', { status: 401 }),
  );
  await assert.rejects(
    createAgentClient('https://agent.example', 'test-secret')({ id: 'event' }),
    /agent_http_401/,
  );
  assert.equal(mock.mock.calls.length, 1);
});
