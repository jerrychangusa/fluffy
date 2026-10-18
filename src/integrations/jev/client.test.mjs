import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from './client.mjs';

const action = {
  to: 'owner@example.test',
  subject: 'Order 1042',
  body_text: 'Please send the missing information.',
  attachments: [
    {
      filename: 'sample.txt',
      size_bytes: 3,
      sha256: 'example',
      content_base64: 'YWJj',
    },
  ],
};

test('Jev receives attachment metadata and returns its policy decision', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const request = JSON.parse(options.body);
    assert.equal(request.state.action.attachments[0].content_base64, undefined);
    assert.equal(request.state.action.attachments[0].filename, 'sample.txt');
    assert.match(request.state.policy, /explicit human approval/);
    return Response.json({
      model: 'test-jev',
      answers: { route: { choice: 'deny', confidence: 0.99 } },
    });
  });
  const result = await assess(action, 'sample-key');
  assert.equal(result.source, 'jev');
  assert.equal(result.choice, 'deny');
});

test('missing Jev credentials require human review without making an API call', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch', () =>
    assert.fail('No credentials supplied.'),
  );
  assert.equal((await assess(action)).choice, 'review');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('provider failure or an invalid Jev answer falls back to human review', async (context) => {
  let answer = 'unexpected-answer';
  context.mock.method(globalThis, 'fetch', async () => {
    if (answer === 'unavailable') throw new Error('Provider unavailable.');
    return Response.json({ answers: { route: { choice: answer } } });
  });
  assert.equal((await assess(action, 'sample-key')).choice, 'review');
  answer = 'unavailable';
  assert.equal((await assess(action, 'sample-key')).choice, 'review');
});

test('tool assessments send typed tool context and preserve confidence', async (context) => {
  const { assessToolCall } = await import('./client.mjs');
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.state.tool.name, 'read_order');
    assert.equal(request.questions.route.type, 'choice');
    assert.deepEqual(Object.keys(request.questions.route.criteria).sort(), [
      'allow',
      'deny',
      'review',
    ]);
    return Response.json({
      model: 'test-jev',
      answers: { route: { choice: 'allow', confidence: 0.95 } },
    });
  });
  const result = await assessToolCall(
    {
      tool: { name: 'read_order' },
      arguments: {},
      context: {},
      policy: 'Example read policy',
    },
    'sample-key',
  );
  assert.equal(result.choice, 'allow');
  assert.equal(result.confidence, 0.95);
});
