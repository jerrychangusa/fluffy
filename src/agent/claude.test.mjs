import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarness } from './claude.mjs';
import { createEmailTools, guardSdkTools } from './tools.mjs';

function createTestTools(context) {
  return guardSdkTools(createEmailTools(context), {
    rules: {
      read_attachment: {
        effect: 'read',
        mode: 'automatic',
        inspect: (args) => args,
      },
      send_email: {
        effect: 'external_write',
        mode: 'review',
        inspect: (args) => args,
        review: (args) => context.requestAction(args),
      },
    },
    assess: async () => ({ source: 'jev', choice: 'allow', confidence: 0.99 }),
    policy: 'Synthetic test policy',
    toolCalls: context.toolCalls,
  });
}

function temporaryDirectory(context) {
  const directory = mkdtempSync(path.join(tmpdir(), 'permission-harness-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('resumed SDK turns retain the restricted tools and isolated subprocess environment', async (context) => {
  let closed = false;
  const sessionIds = [];
  const run = createHarness({
    directory: temporaryDirectory(context),
    apiKey: 'sample-api-key',
    createTools: createTestTools,
    systemPrompt: 'Synthetic test application.',
    queryStream({ prompt, options }) {
      assert.equal(options.resume, 'saved-session');
      assert.deepEqual(options.tools, []);
      assert.deepEqual(options.settingSources, []);
      assert.equal(options.strictMcpConfig, true);
      assert.deepEqual(options.allowedTools, [
        'mcp__permissions__read_attachment',
        'mcp__permissions__send_email',
      ]);
      assert.deepEqual(
        Object.keys(options.env).sort(),
        [
          'ANTHROPIC_API_KEY',
          'CLAUDE_AGENT_SDK_CLIENT_APP',
          'CLAUDE_CONFIG_DIR',
          'HOME',
          'PATH',
        ].sort(),
      );
      assert.equal(
        JSON.stringify(JSON.parse(prompt)).includes('content_base64'),
        false,
      );
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'saved-session',
          };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'saved-session',
            total_cost_usd: 0.01,
            result: 'Recorded.',
          };
        },
        close() {
          closed = true;
        },
      };
    },
  });

  const result = await run({
    event: { kind: 'receipt', receipt: { status: 'executed' } },
    conversation: {
      session_id: 'saved-session',
      latest_email: {
        subject: 'Order',
        body_text: 'Help',
        attachments: [
          {
            filename: 'sample.png',
            content_type: 'image/png',
            content_base64: 'sample-image-bytes',
          },
        ],
      },
    },
    requestAction: async () =>
      assert.fail('A completion must not request an action.'),
    onSession: (id) => sessionIds.push(id),
  });
  assert.deepEqual(sessionIds, ['saved-session', 'saved-session']);
  assert.equal(result.resumed, true);
  assert.equal(result.cost_usd, 0.01);
  assert.equal(closed, true);
});

test('an incomplete SDK turn closes its stream and cannot report success', async (context) => {
  let closed = false;
  const run = createHarness({
    directory: temporaryDirectory(context),
    apiKey: 'sample-api-key',
    createTools: createTestTools,
    systemPrompt: 'Synthetic test application.',
    queryStream: () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'error_max_turns',
          session_id: 'session',
        };
      },
      close() {
        closed = true;
      },
    }),
  });
  await assert.rejects(
    run({
      event: { kind: 'customer' },
      conversation: {},
      requestAction() {},
      onSession() {},
    }),
    /agent_turn_incomplete/,
  );
  assert.equal(closed, true);
});

test('attachment and proposal tools preserve data handling without granting send capability', async () => {
  const toolCalls = [];
  const tools = createTestTools({
    event: {
      email: {
        attachments: [
          {
            filename: 'note.txt',
            content_type: 'text/plain',
            content_base64: Buffer.from('untrusted note').toString('base64'),
          },
          {
            filename: 'sample.png',
            content_type: 'image/png',
            content_base64: 'aW1hZ2U=',
          },
          {
            filename: 'sample.pdf',
            content_type: 'application/pdf',
            content_base64: 'cGRm',
          },
        ],
      },
    },
    conversation: {},
    requestAction: async () => ({
      status: 'pending',
      request_id: 'test-request',
    }),
    toolCalls,
  });
  const attachmentTool = tools.find((tool) => tool.name === 'read_attachment');
  const text = await attachmentTool.handler({ index: 0 });
  assert.equal(
    JSON.parse(text.content[0].text).untrusted_text,
    'untrusted note',
  );
  assert.equal(
    (await attachmentTool.handler({ index: 1 })).content[0].type,
    'image',
  );
  const pdf = await attachmentTool.handler({ index: 2 });
  assert.match(JSON.parse(pdf.content[0].text).note, /human review/);

  const proposal = await tools
    .find((tool) => tool.name === 'send_email')
    .handler({ subject: 'Re: Order', body_text: 'Test reply' });
  assert.equal(JSON.parse(proposal.content[0].text).status, 'pending');
  assert.equal(
    tools.some((tool) => tool.name === 'request_action'),
    false,
  );
  assert.deepEqual(toolCalls, [
    'read_attachment',
    'read_attachment',
    'read_attachment',
    'send_email',
  ]);
});

test('the harness rejects raw tools before starting the SDK', async (context) => {
  const run = createHarness({
    directory: temporaryDirectory(context),
    apiKey: 'sample-key',
    systemPrompt: 'Test agent',
    createTools: createEmailTools,
    queryStream: () =>
      assert.fail('unguarded tools must never reach the model'),
  });
  await assert.rejects(
    run({
      event: { kind: 'customer' },
      conversation: {},
      requestAction() {},
      onSession() {},
    }),
    /unguarded_tools_not_allowed/,
  );
});
