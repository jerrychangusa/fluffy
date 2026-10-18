import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolGateway, toolCallHash } from 'agent-approval-service';

const allow = { source: 'jev', choice: 'allow', confidence: 0.99 };
const definition = (overrides = {}) => ({
  name: 'read_record',
  effect: 'read',
  mode: 'automatic',
  validate: (args) => {
    assert.equal(typeof args, 'object');
    return args;
  },
  inspect: (args) => args,
  execute: async () => 'protected result',
  ...overrides,
});
function gateway(tools, overrides = {}) {
  return new ToolGateway({
    tools,
    assess: async () => allow,
    policy: 'Test policy',
    ...overrides,
  });
}

test('a read cannot expose data until the sentinel has allowed it', async () => {
  let finishAssessment;
  let entered;
  let reads = 0;
  const assessing = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = gateway(
    [
      definition({
        execute: async () => {
          reads++;
          return 'sensitive data';
        },
      }),
    ],
    {
      assess: () => {
        entered();
        return new Promise((resolve) => {
          finishAssessment = resolve;
        });
      },
    },
  );
  const result = gate.invoke('read_record', {});
  await assessing;
  assert.equal(reads, 0);
  finishAssessment(allow);
  assert.equal((await result).result, 'sensitive data');
  assert.equal(reads, 1);
});

test('a policy-required approval cannot be weakened by Jev allow', async () => {
  let executions = 0;
  let requests = 0;
  const gate = gateway([
    definition({
      mode: 'review',
      effect: 'external_write',
      execute: async () => {
        executions++;
      },
      review: async (args, decision) => {
        requests++;
        assert.equal(decision.decision, 'review');
        assert.equal(args.to, 'customer@example.com');
        return { status: 'pending', request_id: 'request-1' };
      },
    }),
  ]);
  const result = await gate.invoke('read_record', {
    to: 'customer@example.com',
  });
  assert.equal(result.status, 'pending');
  assert.equal(requests, 1);
  assert.equal(executions, 0);
});

test('hard recipient restrictions and sentinel denial prevent both execution and approval mail', async () => {
  let assessments = 0;
  let requests = 0;
  let executions = 0;
  const tool = definition({
    mode: 'review',
    check: (args) =>
      args.to === 'customer@example.com' ? null : 'recipient_forbidden',
    execute: async () => {
      executions++;
    },
    review: async () => {
      requests++;
    },
  });
  const gate = gateway([tool], {
    assess: async () => {
      assessments++;
      return { ...allow, choice: 'deny' };
    },
  });
  assert.equal(
    (await gate.invoke('read_record', { to: 'stranger@example.com' })).reason,
    'recipient_forbidden',
  );
  assert.equal(assessments, 0);
  assert.equal(
    (await gate.invoke('read_record', { to: 'customer@example.com' })).reason,
    'sentinel_denied',
  );
  assert.equal(requests, 0);
  assert.equal(executions, 0);
});

test('uncertain, missing, invalid, and unavailable assessments never release a tool result', async () => {
  for (const assessment of [
    null,
    { ...allow, confidence: 0.5 },
    { ...allow, confidence: 9 },
    { ...allow, confidence: undefined },
    { ...allow, source: 'unavailable' },
    { ...allow, choice: 'unexpected' },
    'throw',
  ]) {
    const gate = gateway(
      [definition({ execute: () => assert.fail('must not read') })],
      {
        assess: async () => {
          if (assessment === 'throw') throw Error('unavailable');
          return assessment;
        },
      },
    );
    const result = await gate.invoke('read_record', {});
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'human_review_required_no_adapter');
  }
});

test('a protected read can defer through an application-provided approval adapter', async () => {
  const gate = gateway([
    definition({
      mode: 'review',
      execute: () => assert.fail('must not read'),
      review: async () => ({ status: 'pending', request_id: 'read-approval' }),
    }),
  ]);
  assert.equal(
    (await gate.invoke('read_record', {})).request_id,
    'read-approval',
  );
});

test('pending approval blocks queued parallel reads, writes, and duplicate requests', async () => {
  let reads = 0;
  let writes = 0;
  let requests = 0;
  const gate = gateway([
    definition({
      name: 'send_email',
      mode: 'review',
      effect: 'external_write',
      review: async () => {
        requests++;
        return { status: 'pending', request_id: 'one-request' };
      },
    }),
    definition({
      execute: async () => {
        reads++;
      },
    }),
    definition({
      name: 'write_record',
      effect: 'write',
      execute: async () => {
        writes++;
      },
    }),
  ]);
  const results = await Promise.all([
    gate.invoke('send_email', {}),
    gate.invoke('read_record', {}),
    gate.invoke('write_record', {}),
    gate.invoke('send_email', { changed: true }),
  ]);
  assert.ok(
    results.every(
      (result) =>
        result.status === 'pending' && result.request_id === 'one-request',
    ),
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(requests, 1);
});

test('the frozen call is identical for assessment, approval, and hash despite caller mutation', async () => {
  let start;
  let finish;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  let approved;
  const gate = gateway(
    [
      definition({
        mode: 'review',
        review: async (args) => {
          approved = args;
          return { status: 'pending', request_id: 'fixed' };
        },
      }),
    ],
    {
      assess: async (call) => {
        assert.equal(call.arguments.message.text, 'original');
        start();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  const args = { message: { text: 'original' } };
  const task = gate.invoke('read_record', args);
  args.message.text = 'mutated before queue';
  await started;
  args.message.text = 'mutated during assessment';
  finish(allow);
  const result = await task;
  assert.equal(approved.message.text, 'original');
  assert.ok(Object.isFrozen(approved.message));
  assert.equal(
    result.call_hash,
    toolCallHash('read_record', { message: { text: 'original' } }),
  );
  assert.equal(
    toolCallHash('x', { a: 1, b: 2 }),
    toolCallHash('x', { b: 2, a: 1 }),
  );
  assert.notEqual(toolCallHash('x', {}), toolCallHash('y', {}));
});

test('invalid and unregistered calls never reach the assessor or implementation', async () => {
  const gate = gateway(
    [
      definition({
        validate: () => {
          throw Error('bad shape');
        },
        execute: () => assert.fail(),
      }),
    ],
    { assess: () => assert.fail() },
  );
  assert.equal((await gate.invoke('unknown', {})).reason, 'unregistered_tool');
  assert.equal(
    (await gate.invoke('read_record', {})).reason,
    'invalid_tool_arguments',
  );
});

test('automatic writes deduplicate within a turn; reads remain fresh after a write', async () => {
  let value = 0;
  const gate = gateway([
    definition({ execute: async () => value }),
    definition({
      name: 'write_record',
      effect: 'write',
      execute: async () => ++value,
    }),
  ]);
  assert.equal((await gate.invoke('read_record', {})).result, 0);
  await gate.invoke('write_record', {});
  await gate.invoke('write_record', {});
  assert.equal((await gate.invoke('read_record', {})).result, 1);
});

test('an uncertain automatic write outcome is never automatically executed again', async () => {
  let writes = 0;
  const gate = gateway([
    definition({
      effect: 'write',
      execute: async () => {
        writes++;
        throw Error('lost response');
      },
    }),
  ]);
  await assert.rejects(gate.invoke('read_record', {}));
  assert.equal(
    (await gate.invoke('read_record', {})).reason,
    'execution_outcome_unknown',
  );
  assert.equal(writes, 1);
});

test('decision audit omits tool arguments and protected results', async () => {
  const decisions = [];
  const gate = gateway([definition()], {
    onDecision: (decision) => decisions.push(decision),
  });
  await gate.invoke('read_record', { secret: 'sample-secret' });
  assert.equal(decisions[0].decision, 'allow');
  assert.equal(JSON.stringify(decisions).includes('sample-secret'), false);
  assert.equal(JSON.stringify(decisions).includes('protected result'), false);
});
