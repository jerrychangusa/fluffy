import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { State } from '../agent/state.mjs';
import { AgentService } from '../agent/service.mjs';
import { createAgentServer } from '../agent/http.mjs';
import { ToolGateway } from '../gateway/gateway.mjs';
import {
  TraceService,
  ownerAuthenticator,
  createTraceProvider,
} from './service.mjs';
const event = {
  id: 'email-1',
  conversation_id: 'thread-1',
  kind: 'customer',
  email: {
    id: 'email-1',
    from_email: 'sender@example.com',
    body_text: 'SECRET',
    attachments: [],
  },
};
function setup(t, options = {}) {
  const dir = mkdtempSync(tmpdir() + '/trace-');
  const state = new State(dir);
  t.after(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const traces = new TraceService({
    state,
    ownerSubject: 'owner',
    now: () => 1700000000000,
    authenticate: async (r) => r.identity,
    ...options,
  });
  return { state, traces, id: traces.begin(event), dir };
}
test('strict object authorization; opaque id, unverified email and unrelated owner do not grant access', async (t) => {
  let reads = 0;
  const { traces, id } = setup(t, {
    provider: {
      read: async () => {
        reads++;
        return {};
      },
    },
  });
  for (const identity of [
    null,
    {},
    { subject: 'other' },
    { email: event.email.from_email },
    { emailVerified: true, email: 'other@example.com' },
  ])
    assert.equal(await traces.read(id, { identity }), null);
  assert.equal(reads, 0);
  assert.ok(await traces.read(id, { identity: { subject: 'owner' } }));
  assert.ok(
    await traces.read(id, {
      identity: { emailVerified: true, email: 'SENDER@example.com' },
    }),
  );
});
test('projection strips secrets and unknown provider statuses, does not invent received/decision timestamps', async (t) => {
  const { traces, id } = setup(t, {
    provider: {
      read: async () => ({
        email: { body: 'SECRET' },
        approval: {
          status: 'pending',
          prompt: 'SECRET',
          events: Array(40).fill({ detail: 'SECRET' }),
        },
        sent: { status: 'SECRET' },
      }),
    },
  });
  traces.append(event.id, {
    type: 'gateway_decision',
    tool: 'read_case',
    decision: 'allow',
    reason: 'SECRET',
    arguments: 'SECRET',
  });
  const result = await traces.read(id, { identity: { subject: 'owner' } });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(result.email.received_at, null);
  assert.equal(result.approval.decided_at, null);
  assert.equal(result.delivery.state, 'unknown');
  assert.equal(result.events.at(-1).status, 'observed');
  assert.equal(result.completeness.history_truncated, true);
});
test('GET provider routes questions separately, verifies binding, never mutates', async () => {
  for (const protocol of ['permission.receipt/1', 'question.receipt/1']) {
    const calls = [];
    const provider = createTraceProvider(async (...args) => {
      assert.equal(args.length, 1);
      const url = decodeURIComponent(args[0]);
      calls.push(url);
      if (url.startsWith('/emails/'))
        return { received_at: '2026-01-01T00:00:00Z' };
      if (url.includes('inbox/event/'))
        return { value: { permission_id: '0123456789ABCDEF' } };
      if (url.includes('inbox/request/'))
        return {
          value: { receipt_protocol: protocol, customer_email: event.email },
        };
      if (url.includes('/memories'))
        return {
          value: { execution: { provider_id: 'sent-1' }, status: 'pending' },
        };
      return { status: 'delivered' };
    });
    const result = await provider.read({
      event_id: event.id,
      email_id: event.email.id,
      sender: event.email.from_email,
    });
    assert.ok(
      calls.some((url) =>
        url.includes(
          protocol.startsWith('question') ? 'questions/' : 'approval/',
        ),
      ),
    );
    assert.equal(!!result.sent, protocol.startsWith('permission'));
  }
});
test('a teammate answer trace follows its new approval, not the original customer question', async (t) => {
  const questionId = 'AAAAAAAAAAAAAAAA';
  const approvalId = 'BBBBBBBBBBBBBBBB';
  // The real inbox includes the original customer email on a receipt event.
  const receipt = {
    id: 'question-answer-receipt',
    kind: 'receipt',
    conversation_id: event.conversation_id,
    email: event.email,
    receipt: { request_id: questionId, status: 'answered' },
  };
  const records = new Map([
    ['/emails/' + event.email.id, { received_at: '2026-10-18T10:00:00Z' }],
    [
      '/memories?key=inbox/event/' + event.id,
      { value: { permission_id: questionId } },
    ],
    [
      '/memories?key=inbox/event/' + receipt.id,
      { value: { permission_id: approvalId } },
    ],
    [
      '/memories?key=inbox/request/' + questionId,
      {
        value: {
          customer_email: event.email,
          receipt_protocol: 'question.receipt/1',
        },
      },
    ],
    [
      '/memories?key=inbox/request/' + approvalId,
      {
        value: {
          customer_email: event.email,
          receipt_protocol: 'permission.receipt/1',
        },
      },
    ],
    [
      '/memories?key=questions/' + questionId,
      { value: { status: 'answered' } },
    ],
    [
      '/memories?key=approval/' + approvalId,
      {
        value: {
          status: 'executed',
          execution: { provider_id: 'final-email' },
        },
      },
    ],
    ['/sent-emails/final-email', { status: 'delivered' }],
  ]);
  const calls = [];
  const { traces, id } = setup(t, {
    provider: createTraceProvider(async (...args) => {
      assert.equal(args.length, 1, 'provider reads must remain GET-only');
      const path = decodeURIComponent(args[0]);
      calls.push(path);
      assert.ok(records.has(path), path);
      return records.get(path);
    }),
  });
  const original = await traces.read(id, { identity: { subject: 'owner' } });
  assert.equal(original.approval.status, 'answered');
  assert.equal(original.delivery.state, 'unknown');
  calls.length = 0;
  const resumed = await traces.read(traces.begin(receipt), {
    identity: { subject: 'owner' },
  });
  assert.equal(resumed.approval.status, 'executed');
  assert.equal(resumed.delivery.state, 'delivered');
  assert.ok(calls.includes('/memories?key=inbox/event/' + receipt.id));
  assert.equal(calls.includes('/memories?key=inbox/event/' + event.id), false);
});
test('a resumed trace still rejects a request bound to another customer', async () => {
  const calls = [];
  const provider = createTraceProvider(async (url) => {
    const path = decodeURIComponent(url);
    calls.push(path);
    if (path.startsWith('/emails/')) return {};
    if (path.includes('inbox/event/'))
      return { value: { permission_id: 'AAAAAAAAAAAAAAAA' } };
    if (path.includes('inbox/request/'))
      return {
        value: {
          customer_email: { ...event.email, from_email: 'other@example.com' },
          receipt_protocol: 'permission.receipt/1',
        },
      };
    assert.fail('must not read a mismatched approval or delivery');
  });
  const result = await provider.read({
    event_id: 'question-answer-receipt',
    email_id: event.email.id,
    sender: event.email.from_email,
  });
  assert.deepEqual(result, { email: {} });
  assert.equal(calls.length, 3);
});
test('instrumentation persists across reopen, replay adds no events, gateway allow is not completion', async (t) => {
  const { state, traces, id, dir } = setup(t);
  const run = async ({ onExecution, onDecision }) => {
    const gateway = new ToolGateway({
      tools: [
        {
          name: 'read_case',
          effect: 'read',
          mode: 'automatic',
          validate: (x) => x,
          inspect: (x) => x,
          execute: async () => ({ isError: true, secret: 'SECRET' }),
        },
      ],
      policy: 'policy',
      assess: async () => ({ source: 'jev', choice: 'allow', confidence: 1 }),
      onDecision,
      onExecution,
    });
    await gateway.invoke('read_case', {});
    return {};
  };
  const service = new AgentService({ state, traces, run });
  await service.handle(event);
  const first = await traces.read(id, { identity: { subject: 'owner' } });
  assert.deepEqual(
    first.events.map((x) => x.type),
    [
      'event_received',
      'run_started',
      'gateway_decision',
      'tool_started',
      'tool_failed',
    ],
  );
  await service.handle(event);
  assert.deepEqual(
    (await traces.read(id, { identity: { subject: 'owner' } })).events,
    first.events,
  );
  const reopened = new State(dir);
  t.after(() => reopened.close());
  const restored = new TraceService({
    state: reopened,
    authenticate: async () => ({ subject: 'owner' }),
  });
  assert.deepEqual((await restored.read(id, {})).events, first.events);
});
test('HTTP defaults off and returns indistinguishable no-store 404; authorized polling is read-only', async (t) => {
  const { traces, id } = setup(t, {
    authenticate: ownerAuthenticator({
      token: 'existing-private-credential',
      subject: 'owner',
    }),
  });
  const server = createAgentServer({
    traces,
    service: {
      handle: () => {
        throw Error('must not run');
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/traces/';
  for (const suffix of [id, 'x'.repeat(32), '../bad']) {
    const response = await fetch(url + suffix);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  }
  const response = await fetch(url + id, {
    headers: { Authorization: 'Bearer existing-private-credential' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).protocol, 'fluffy.trace/1');
});
test('historical checkpoint keeps unknown timestamps and never claims completion instrumentation', async (t) => {
  const { traces, state } = setup(t);
  const old = { ...event, id: 'old-email' };
  state.put('event/old-email', {
    result: {
      status: 'completed',
      gateway_decisions: [
        { decision: 'allow', tool: 'read_case', reasoning: 'SECRET' },
      ],
    },
  });
  const id = traces.begin(old);
  const dto = await traces.read(id, { identity: { subject: 'owner' } });
  assert.equal(dto.events.length, 1);
  assert.equal(dto.events[0].at, null);
  assert.equal(dto.events[0].status, 'observed');
  assert.equal(dto.completeness.tool_completion_events_available, false);
  assert.equal(dto.completeness.timestamps_partial, true);
});
test('provider outages preserve local evidence and report disconnected', async (t) => {
  const { traces, id } = setup(t, {
    provider: {
      read: async () => {
        throw Error('SECRET');
      },
    },
  });
  const dto = await traces.read(id, { identity: { subject: 'owner' } });
  assert.equal(dto.completeness.live_connected, false);
  assert.equal(dto.delivery.state, 'unknown');
  assert.equal(dto.events.length, 1);
});
test('tool success and thrown failure emit ordered execution events; review never executes', async () => {
  for (const mode of ['success', 'throw', 'review']) {
    const events = [];
    const gateway = new ToolGateway({
      policy: 'policy',
      assess: async () => ({ source: 'jev', choice: 'allow', confidence: 1 }),
      onExecution: (e) => events.push(e.type),
      tools: [
        {
          name: 'read_case',
          effect: 'read',
          mode: mode === 'review' ? 'review' : 'automatic',
          validate: (x) => x,
          inspect: (x) => x,
          review: async () => ({ status: 'pending', request_id: 'request' }),
          execute: async () => {
            if (mode === 'throw') throw Error('SECRET');
            return {};
          },
        },
      ],
    });
    if (mode === 'throw') await assert.rejects(gateway.invoke('read_case', {}));
    else await gateway.invoke('read_case', {});
    assert.deepEqual(
      events,
      mode === 'review'
        ? []
        : ['tool_started', mode === 'throw' ? 'tool_failed' : 'tool_succeeded'],
    );
  }
});
test('cold observation clock is unknown, never fabricates time or hides an authorized trace', async (t) => {
  const { traces, id, state } = setup(t);
  const snapshot = JSON.stringify(state.get('trace/' + id));
  traces.now = () => {
    throw Error('clock_not_ready');
  };
  const dto = await traces.read(id, { identity: { subject: 'owner' } });
  assert.equal(dto.observed_at, null);
  assert.equal(dto.completeness.timestamps_partial, true);
  assert.equal(JSON.stringify(state.get('trace/' + id)), snapshot);
});
test('truncated local history plus provider lifecycle retains increasing display sequence', async (t) => {
  const { traces, id } = setup(t, {
    provider: {
      read: async () => ({
        approval: { events: [{ kind: 'requested', at: 1700000000000 }] },
      }),
    },
  });
  for (let n = 0; n < 210; n++)
    traces.append(event.id, { type: 'session_started' });
  const dto = await traces.read(id, { identity: { subject: 'owner' } });
  assert.equal(dto.completeness.history_truncated, true);
  for (let n = 1; n < dto.events.length; n++)
    assert.ok(dto.events[n].sequence > dto.events[n - 1].sequence);
});
test('identity headers cannot impersonate the owner; GET changes no SQLite records', async (t) => {
  const { traces, id, state } = setup(t, {
    authenticate: ownerAuthenticator({ token: 'private', subject: 'owner' }),
  });
  assert.equal(
    await traces.read(id, {
      headers: {
        'x-user-id': 'owner',
        'x-user-email': event.email.from_email,
        'x-email-verified': 'true',
      },
    }),
    null,
  );
  const before = state.db.prepare('SELECT * FROM state ORDER BY key').all();
  await traces.read(id, { headers: { authorization: 'Bearer private' } });
  assert.deepEqual(
    state.db.prepare('SELECT * FROM state ORDER BY key').all(),
    before,
  );
});
test('capped historical decisions are marked potentially truncated', async (t) => {
  const { traces, state } = setup(t);
  state.put('event/old-capped', {
    result: {
      gateway_decisions: Array(24).fill({
        tool: 'read_case',
        decision: 'allow',
      }),
    },
  });
  const id = traces.begin({ ...event, id: 'old-capped' });
  assert.equal(
    (await traces.read(id, { identity: { subject: 'owner' } })).completeness
      .history_truncated,
    true,
  );
});
test('a missing checkpoint preserves known email evidence; no provider mutation', async () => {
  const provider = createTraceProvider(async (...args) => {
    assert.equal(args.length, 1);
    if (args[0].startsWith('/emails/'))
      return { received_at: '2026-10-18T00:00:00Z' };
    throw Object.assign(Error('not_found'), { status: 404 });
  });
  const result = await provider.read({
    event_id: 'email-1',
    email_id: 'email-1',
  });
  assert.equal(result.email.received_at, '2026-10-18T00:00:00Z');
  assert.equal(result.checkpoint, null);
});
test('rolling lifecycle history preserves IDs of retained distinguishable events', async (t) => {
  const history = [
    { kind: 'requested', at: 1700000000000 },
    { kind: 'approved', at: 1700000001000 },
  ];
  const { traces, id } = setup(t, {
    provider: { read: async () => ({ approval: { events: history } }) },
  });
  const first = await traces.read(id, { identity: { subject: 'owner' } });
  history.shift();
  const next = await traces.read(id, { identity: { subject: 'owner' } });
  assert.equal(first.events.at(-1).id, next.events.at(-1).id);
});
