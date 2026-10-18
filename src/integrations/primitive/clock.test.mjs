import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrimitiveClock } from './clock.mjs';

test('the clock refreshes after suspension even when guest time did not advance', async () => {
  const initial = Date.parse('2026-10-18T09:00:00Z');
  let providerTime = initial;
  let elapsed = 0;
  const clock = createPrimitiveClock({
    elapsed: () => elapsed,
    request: async (url, options) => {
      assert.equal(url, 'https://api.primitive.dev/v1');
      assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers.Authorization, undefined);
      return new Response(null, {
        status: 404,
        headers: { Date: new Date(providerTime).toUTCString() },
      });
    },
  });
  assert.throws(() => clock.now(), /clock_not_ready/);
  await clock.synchronize();
  elapsed += 1250;
  assert.equal(clock.now(), initial + 1250);
  // Standby pauses guest time; the next request still gets current UTC.
  providerTime += 60 * 60 * 1000;
  await clock.synchronize();
  assert.equal(clock.now(), providerTime);
});

test('missing, malformed or cached provider dates are rejected', async () => {
  for (const headers of [
    {},
    { Date: 'not a timestamp' },
    { Date: 'Sun, 18 Oct 2026 09:00:00 GMT', Age: '300' },
  ]) {
    const clock = createPrimitiveClock({
      request: async () => new Response(null, { headers }),
    });
    await assert.rejects(clock.synchronize(), /clock_unavailable/);
    assert.throws(() => clock.now(), /clock_not_ready/);
  }
});
