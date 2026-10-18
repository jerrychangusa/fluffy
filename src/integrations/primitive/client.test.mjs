import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrimitiveClient } from './client.mjs';

test('Primitive deletes accept a successful empty response', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 204 }),
  );
  assert.equal(
    await createPrimitiveClient({ PRIMITIVE_API_KEY: 'test' }).api(
      '/resource',
      'DELETE',
    ),
    null,
  );
});

test('non-JSON provider failures preserve their HTTP status without exposing response bodies', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('<html>upstream unavailable</html>', { status: 502 }),
  );
  await assert.rejects(
    createPrimitiveClient({ PRIMITIVE_API_KEY: 'test' }).api('/resource'),
    (error) =>
      error.status === 502 && error.message === 'Primitive 502 request_failed',
  );
});
