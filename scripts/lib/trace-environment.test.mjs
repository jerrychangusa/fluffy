import test from 'node:test';
import assert from 'node:assert/strict';
import { traceEnvironment } from './trace-environment.mjs';

const revision = 'a'.repeat(40);
const enabled = {
  TRACE_ENABLED: 'true',
  TRACE_OWNER_SUBJECT: 'operator:owner',
  TRACE_OWNER_TOKEN: 'private-owner-fixture',
  AGENT_BRIDGE_SECRET: 'different-bridge-fixture',
};

test('trace deployment defaults off and never forwards incidental credentials', () => {
  const result = traceEnvironment({
    TRACE_OWNER_TOKEN: 'unused-token',
    PRIMITIVE_API_KEY: 'deployment-only-fixture',
    PRIMITIVE_API_BASE_URL: 'https://api.primitive.dev/v1',
    SOURCE_REVISION: revision,
    UNRELATED_SECRET: 'must-not-forward',
  });
  assert.deepEqual(result, {
    TRACE_ENABLED: 'false',
    TRACE_PROVIDER_ENABLED: 'false',
  });
});

test('enabled trace deployment forwards identity and revision without granting provider access', () => {
  const env = { ...enabled, PRIMITIVE_API_KEY: 'deployment-only-fixture' };
  const result = traceEnvironment(env, revision);
  assert.deepEqual(result, {
    TRACE_ENABLED: 'true',
    TRACE_OWNER_SUBJECT: enabled.TRACE_OWNER_SUBJECT,
    TRACE_OWNER_TOKEN: enabled.TRACE_OWNER_TOKEN,
    TRACE_PROVIDER_ENABLED: 'false',
    SOURCE_REVISION: revision,
  });
  assert.equal(
    traceEnvironment({ ...env, SOURCE_REVISION: 'b'.repeat(40) }, revision)
      .SOURCE_REVISION,
    'b'.repeat(40),
  );
});

test('provider credentials and client configuration require both explicit opt-ins', () => {
  const env = {
    ...enabled,
    TRACE_PROVIDER_ENABLED: 'true',
    PRIMITIVE_API_KEY: 'existing-provider-fixture',
    PRIMITIVE_API_BASE_URL: 'https://api.primitive.dev/v1',
    PRIMITIVE_FUNCTION_ID: '11111111-1111-4111-a111-111111111111',
    UNRELATED_SECRET: 'must-not-forward',
  };
  assert.deepEqual(traceEnvironment(env, revision), {
    TRACE_ENABLED: 'true',
    TRACE_OWNER_SUBJECT: enabled.TRACE_OWNER_SUBJECT,
    TRACE_OWNER_TOKEN: enabled.TRACE_OWNER_TOKEN,
    TRACE_PROVIDER_ENABLED: 'true',
    SOURCE_REVISION: revision,
    PRIMITIVE_API_KEY: env.PRIMITIVE_API_KEY,
    PRIMITIVE_API_BASE_URL: env.PRIMITIVE_API_BASE_URL,
    PRIMITIVE_FUNCTION_ID: env.PRIMITIVE_FUNCTION_ID,
  });
  assert.throws(
    () => traceEnvironment({ TRACE_PROVIDER_ENABLED: 'true' }, revision),
    /requires TRACE_ENABLED/,
  );
  assert.throws(
    () =>
      traceEnvironment(
        { ...enabled, TRACE_PROVIDER_ENABLED: 'true' },
        revision,
      ),
    /invalid_PRIMITIVE_API_KEY/,
  );
});

test('trace deployment rejects invalid flags, missing identity, bridge reuse and invalid revisions', () => {
  for (const key of ['TRACE_ENABLED', 'TRACE_PROVIDER_ENABLED'])
    assert.throws(
      () => traceEnvironment({ ...enabled, [key]: 'yes' }, revision),
      new RegExp('invalid_' + key),
    );
  for (const key of ['TRACE_OWNER_SUBJECT', 'TRACE_OWNER_TOKEN'])
    assert.throws(
      () => traceEnvironment({ ...enabled, [key]: '' }, revision),
      new RegExp('invalid_' + key),
    );
  assert.throws(
    () =>
      traceEnvironment(
        { ...enabled, TRACE_OWNER_TOKEN: enabled.AGENT_BRIDGE_SECRET },
        revision,
      ),
    /must not reuse/,
  );
  assert.throws(() => traceEnvironment(enabled), /SOURCE_REVISION/);
  assert.throws(
    () =>
      traceEnvironment({ ...enabled, SOURCE_REVISION: 'not-a-sha' }, revision),
    /SOURCE_REVISION/,
  );
});

test('unsafe env-file values and provider endpoints fail without exposing their contents', () => {
  const provider = {
    ...enabled,
    TRACE_PROVIDER_ENABLED: 'true',
    PRIMITIVE_API_KEY: 'existing-provider-fixture',
  };
  for (const key of [
    'TRACE_OWNER_SUBJECT',
    'TRACE_OWNER_TOKEN',
    'PRIMITIVE_API_KEY',
  ]) {
    for (const value of [
      'secret\nINJECTED=true',
      'secret\\nINJECTED=true',
      'secret#comment',
      'secret"quote',
      ' secret',
    ]) {
      assert.throws(
        () => traceEnvironment({ ...provider, [key]: value }, revision),
        (error) => error.message === 'invalid_' + key,
      );
    }
  }
  for (const base of [
    'not-a-url',
    'http://api.primitive.dev/v1',
    'https://user:secret@api.primitive.dev/v1',
    'https://api.primitive.dev/v1?key=secret',
  ])
    assert.throws(
      () =>
        traceEnvironment(
          { ...provider, PRIMITIVE_API_BASE_URL: base },
          revision,
        ),
      /invalid_PRIMITIVE_API_BASE_URL/,
    );
  assert.throws(
    () =>
      traceEnvironment(
        { ...provider, PRIMITIVE_FUNCTION_ID: 'not-a-uuid' },
        revision,
      ),
    /invalid_PRIMITIVE_FUNCTION_ID/,
  );
});
