import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentService } from './service.mjs';
import { draftAction } from './contracts.mjs';
import { State } from './state.mjs';
const customer = (id = 'email-1') => ({
  id,
  kind: 'customer',
  conversation_id: 'thread-1',
  email: {
    id,
    subject: 'My order',
    body_text: 'What is missing?',
    attachments: [],
  },
});
const draft = {
  subject: 'Re: My order',
  body_text: 'Please reply with your prescription image and PD.',
};
function setup(context, run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'email-agent-'));
  const state = new State(directory);
  context.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { dir: directory, state, service: new AgentService({ state, run }) };
}
test('inbound email starts a session; duplicate event never repeats the model or proposal', async (context) => {
  let modelRuns = 0;
  const fixture = setup(context, async ({ requestAction, onSession }) => {
    modelRuns++;
    onSession('session-1');
    await requestAction(draft);
    return { text: 'Pending', resumed: false };
  });
  const initial = await fixture.service.handle(customer());
  assert.equal(initial.status, 'waiting_for_approval');
  assert.equal(initial.session_id, 'session-1');
  assert.equal(
    initial.proposal.request_id,
    'af523246-f2a6-4349-ac8b-f742a3602e08',
  );
  const result = await fixture.service.handle(customer());
  assert.equal(result.replayed, true);
  assert.equal(modelRuns, 1);
});
test('CHANGE resumes the stored session and creates a fresh immutable request', async (context) => {
  const seenSessions = [];
  const fixture = setup(
    context,
    async ({ event, conversation, requestAction, onSession }) => {
      seenSessions.push(conversation.session_id);
      onSession('session-1');
      await requestAction({
        ...draft,
        body_text:
          event.kind === 'receipt' ? 'Updated per feedback.' : draft.body_text,
      });
      return { resumed: !!conversation.session_id };
    },
  );
  const initial = await fixture.service.handle(customer());
  const result = await fixture.service.handle({
    id: 'change-1',
    kind: 'receipt',
    conversation_id: 'thread-1',
    receipt: {
      request_id: 'A'.repeat(16),
      client_request_id: initial.proposal.request_id,
      status: 'changes_requested',
      feedback: 'Make it shorter.',
    },
  });
  assert.deepEqual(seenSessions, [null, 'session-1']);
  assert.notEqual(initial.proposal.request_id, result.proposal.request_id);
  assert.equal(result.proposal.body_text, 'Updated per feedback.');
});
test('an execution receipt resumes the agent but cannot request a new send', async (context) => {
  const fixture = setup(
    context,
    async ({ event, requestAction, onSession }) => {
      onSession('session-1');
      if (event.kind === 'customer') {
        await requestAction(draft);
      } else {
        await assert.rejects(requestAction(draft), /action_not_allowed/);
      }
      return {};
    },
  );
  const initial = await fixture.service.handle(customer());
  const result = await fixture.service.handle({
    id: 'done-1',
    kind: 'receipt',
    conversation_id: 'thread-1',
    receipt: {
      request_id: 'A'.repeat(16),
      client_request_id: initial.proposal.request_id,
      status: 'executed',
    },
  });
  assert.equal(result.status, 'executed');
  assert.equal(result.proposal, null);
});

test('retrying a CHANGE after failed model turns counts one human revision across restarts', async (context) => {
  const revisions = [];
  let failures = 2;
  const run = async ({ event, conversation, requestAction, onSession }) => {
    onSession('session-1');
    if (event.kind === 'receipt') {
      revisions.push(conversation.revision);
      if (failures-- > 0) throw new Error('temporary model failure');
    }
    await requestAction(draft);
    return { resumed: event.kind === 'receipt' };
  };
  const fixture = setup(context, run);
  const initial = await fixture.service.handle(customer());
  const change = {
    id: 'change-1',
    kind: 'receipt',
    conversation_id: 'thread-1',
    receipt: {
      request_id: 'A'.repeat(16),
      client_request_id: initial.proposal.request_id,
      status: 'changes_requested',
      feedback: 'Make it shorter.',
    },
  };
  await assert.rejects(
    fixture.service.handle(change),
    /temporary model failure/,
  );
  const restarted = new AgentService({ state: fixture.state, run });
  await assert.rejects(restarted.handle(change), /temporary model failure/);
  const revised = await restarted.handle(change);
  assert.deepEqual(revisions, [1, 1, 1]);
  assert.equal(revised.status, 'waiting_for_approval');
  await restarted.handle({
    ...change,
    id: 'change-2',
    receipt: {
      ...change.receipt,
      request_id: 'B'.repeat(16),
      client_request_id: revised.proposal.request_id,
    },
  });
  assert.deepEqual(revisions, [1, 1, 1, 2]);
});
test('unrelated receipts cannot resume a conversation', async (context) => {
  let modelRuns = 0;
  const fixture = setup(context, async () => {
    modelRuns++;
    return {};
  });
  const result = await fixture.service.handle({
    id: 'unknown-1',
    kind: 'receipt',
    conversation_id: 'thread-1',
    receipt: {
      request_id: 'A'.repeat(16),
      client_request_id: 'wrong',
      status: 'changes_requested',
    },
  });
  assert.equal(result.status, 'ignored');
  assert.equal(modelRuns, 0);
});
test('concurrent duplicate deliveries share one model run', async (context) => {
  let modelRuns = 0;
  const fixture = setup(context, async ({ requestAction }) => {
    modelRuns++;
    await new Promise((recovered) => setTimeout(recovered, 10));
    await requestAction(draft);
    return {};
  });
  await Promise.all([
    fixture.service.handle(customer()),
    fixture.service.handle(customer()),
  ]);
  assert.equal(modelRuns, 1);
});
test('a proposed action survives a failed model turn and is recovered without new inference', async (context) => {
  let modelRuns = 0;
  const fixture = setup(context, async ({ requestAction, onSession }) => {
    modelRuns++;
    onSession('saved-session');
    await requestAction(draft);
    throw new Error('process exited');
  });
  await assert.rejects(fixture.service.handle(customer()));
  const savedProposal = fixture.state.get('event/email-1').proposal;
  const service = new AgentService({
    state: fixture.state,
    run: async () => {
      throw Error('must not rerun');
    },
  });
  const recovered = await service.handle(customer());
  assert.deepEqual(recovered.proposal, savedProposal);
  assert.equal(recovered.session_id, 'saved-session');
  assert.equal(modelRuns, 1);
});
test('customer messages received during approval are queued and returned after completion', async (context) => {
  const fixture = setup(
    context,
    async ({ event, requestAction, onSession }) => {
      onSession('session-1');
      if (event.kind === 'customer') {
        await requestAction(draft);
      }
      return {};
    },
  );
  const initial = await fixture.service.handle(customer());
  await fixture.service.handle(customer('email-2'));
  await fixture.service.handle(customer('email-3'));
  const result = await fixture.service.handle({
    id: 'done-1',
    kind: 'receipt',
    conversation_id: 'thread-1',
    receipt: {
      request_id: 'A'.repeat(16),
      client_request_id: initial.proposal.request_id,
      status: 'executed',
    },
  });
  assert.deepEqual(
    result.deferred_emails.map((x) => x.id),
    ['email-2', 'email-3'],
  );
});
test('header injection is rejected at the tool boundary', () => {
  assert.throws(
    () =>
      draftAction(
        { ...draft, subject: 'Hi\nBcc: stranger@example.com' },
        customer(),
      ),
    /invalid_subject/,
  );
});
