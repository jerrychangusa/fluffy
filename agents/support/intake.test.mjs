import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { State } from '../../src/agent/state.mjs';
import { AgentService } from '../../src/agent/service.mjs';
import { CaseStore } from './cases.mjs';
import { createSupportTools } from './tools.mjs';
import { INTAKE_FORM } from '../../assets/intake-form.mjs';
import { supportActions } from './actions.mjs';
import { actionHash } from '../../src/approval/action.mjs';

const allow = async () => ({
  source: 'jev',
  choice: 'allow',
  confidence: 0.99,
});
const file = (emailId, bytes, content_type, filename, part_index = 0) => ({
  source_email_id: emailId,
  part_index,
  size_bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  filename,
  content_type,
  content_base64: bytes.toString('base64'),
});
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'intake-'));
  const state = new State(dir);
  t.after(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const cases = new CaseStore({
    state,
    customerEmail: 'customer@example.com',
    orderId: '1042',
  });
  const id = crypto.randomUUID();
  const event = {
    id,
    kind: 'customer',
    conversation_id: 'case-1',
    email: {
      id,
      from_email: 'customer@example.com',
      subject: 'My glasses',
      body_text: 'Please help with my order.',
      attachments: [],
    },
  };
  return { state, cases, event };
}
async function completedForm(order = '1042', pd = '31 / 31') {
  const document = await PDFDocument.load(
    Buffer.from(INTAKE_FORM.content_base64, 'base64'),
  );
  document.getForm().getTextField('order_reference').setText(order);
  document.getForm().getTextField('pd_text').setText(pd);
  return Buffer.from(await document.save());
}

test('open support access creates isolated cases for new senders and pins each case owner', async (t) => {
  const { state, event } = setup(t);
  const cases = new CaseStore({
    state,
    customerAccess: 'authenticated',
    orderId: '1042',
  });
  const first = cases.read(event, {});
  const other = {
    ...event,
    conversation_id: 'case-2',
    email: {
      ...event.email,
      from_email: 'other@example.com',
      body_text: 'My PD is 62',
    },
  };
  await cases.record(other, {}, { pd_text: '62' });
  assert.equal(cases.read(other, {}).customer_email, 'other@example.com');
  assert.equal(cases.read(event, {}).pd, null);
  assert.equal(first.customer_email, event.email.from_email);
  assert.throws(
    () => cases.read({ ...other, conversation_id: event.conversation_id }, {}),
    /customer_mismatch/,
  );
});
const decode = (result) => JSON.parse(result.content[0].text);

test('returned PDF supplies exact PD with provenance; cases isolate customers and threads', async (t) => {
  const { cases, event } = setup(t);
  event.email.attachments = [
    file(
      event.id,
      await completedForm(),
      'application/pdf',
      'completed-intake.pdf',
    ),
  ];
  let record = await cases.record(event, {}, { form_attachment_index: 0 });
  assert.equal(record.pd.supplied_text, '31 / 31');
  assert.equal(record.pd.source, 'form.pd_text');
  assert.deepEqual(record.missing, ['prescription']);
  const again = await cases.record(event, {}, { form_attachment_index: 0 });
  assert.equal(record.version, again.version);
  assert.equal(record.form.content_base64, undefined);
  assert.deepEqual(
    cases.read({ ...event, conversation_id: 'other-thread' }, {}).missing,
    ['prescription', 'pd'],
  );
  assert.throws(
    () =>
      cases.read(
        {
          ...event,
          email: { ...event.email, from_email: 'other@example.com' },
        },
        {},
      ),
    /customer_mismatch/,
  );
  await assert.rejects(
    cases.record(event, {}, { pd_text: '99' }),
    /quote_customer/,
  );
  event.email.attachments[0] = file(
    event.id,
    await completedForm('other-order'),
    'application/pdf',
    'wrong.pdf',
  );
  await assert.rejects(
    cases.record(event, {}, { form_attachment_index: 0 }),
    /order_mismatch/,
  );
});

test('information requests attach the actual form; completion stays behind approval even when Jev says allow', async (t) => {
  const { cases, event } = setup(t);
  let proposal;
  const tools = createSupportTools(cases, { assess: allow })({
    event,
    conversation: {},
    requestAction: async (input) => {
      proposal = input;
      return { status: 'pending', request_id: crypto.randomUUID() };
    },
  });
  await tools.find((tool) => tool.name === 'request_information').handler({});
  assert.equal(proposal.type, 'support.request');
  assert.equal(proposal.attachments[0].content_type, 'application/pdf');
  assert.equal(decode(await tools[0].handler({})).status, 'blocked');
  const nextId = crypto.randomUUID();
  const next = {
    ...event,
    id: nextId,
    email: {
      ...event.email,
      id: nextId,
      body_text: 'My PD is 62 mm.',
      attachments: [
        file(
          nextId,
          Buffer.from('prescription-file'),
          'image/png',
          'prescription.png',
        ),
      ],
    },
  };
  await cases.record(
    next,
    {},
    { prescription_attachment_index: 0, pd_text: '62 mm' },
  );
  const nextTools = createSupportTools(cases, { assess: allow })({
    event: next,
    conversation: {},
    requestAction: async (input) => {
      proposal = input;
      return { status: 'pending', request_id: crypto.randomUUID() };
    },
  });
  const result = decode(
    await nextTools.find((tool) => tool.name === 'complete_intake').handler({}),
  );
  assert.equal(result.status, 'pending');
  assert.equal(proposal.type, 'support.complete');
  assert.equal(proposal.sentinel.decision, 'review');
  assert.equal(proposal.attachments, undefined);
  assert.equal(proposal.evidence.length, 1);
  assert.equal(cases.read(next, {}).completion, null);
});

test('teammate answers resume the same case but do not grant permission; executed approval records completion once', async (t) => {
  const { state, cases, event } = setup(t);
  event.email.body_text = 'PD 62 mm. Please check my documents.';
  event.email.attachments = [
    file(event.id, Buffer.from('rx'), 'image/png', 'prescription.png'),
  ];
  await cases.record(
    event,
    {},
    { prescription_attachment_index: 0, pd_text: '62 mm' },
  );
  const seen = [];
  const service = new AgentService({
    state,
    onReceipt: (event, conversation) =>
      cases.receiveReceipt(event, conversation),
    run: async (context) => {
      const tools = createSupportTools(cases, { assess: allow })(context);
      seen.push(cases.read(context.event, context.conversation));
      if (context.event.kind === 'customer')
        await tools
          .find((tool) => tool.name === 'ask_teammate')
          .handler({ question: 'Is anything missing from this intake?' });
      else if (context.event.receipt.status === 'answered')
        await tools.find((tool) => tool.name === 'complete_intake').handler({});
      return {};
    },
  });
  const question = await service.handle(event);
  assert.equal(question.status, 'waiting_for_teammate');
  const answer = {
    id: crypto.randomUUID(),
    kind: 'receipt',
    conversation_id: event.conversation_id,
    receipt: {
      protocol: 'question.receipt/1',
      request_id: 'A'.repeat(16),
      client_request_id: question.proposal.request_id,
      status: 'answered',
      answer: {
        text: 'The supplied information is complete.',
        by: 'optician@example.com',
        role: 'optician',
      },
    },
  };
  const review = await service.handle(answer);
  assert.equal(review.status, 'waiting_for_approval');
  assert.equal(seen[1].notes[0].text, 'The supplied information is complete.');
  assert.equal(seen[1].completion, null);
  const done = {
    ...answer,
    id: crypto.randomUUID(),
    receipt: {
      protocol: 'permission.receipt/1',
      request_id: 'B'.repeat(16),
      client_request_id: review.proposal.request_id,
      status: 'executed',
      action_hash: 'c'.repeat(64),
    },
  };
  await service.handle(done);
  await service.handle(done);
  assert.equal(cases.read(event, {}).completion.request_id, 'B'.repeat(16));
});

test('trusted executor separates review evidence and binds it to the exact approval hash', async () => {
  const actions = supportActions('1042');
  const config = {
    customer_sender: 'support@example.com',
    allowed_recipients: ['customer@example.com'],
  };
  const { completionMessage } = await import('./messages.mjs');
  const input = {
    context: { output_attachment_count: 0 },
    action: {
      type: 'support.complete',
      to: 'customer@example.com',
      subject: 'Re: Order',
      body_text: completionMessage('1042'),
      parameters: {
        order_id: '1042',
        case_id: 'case-1',
        case_version: 'a'.repeat(64),
        pd_text: '62 mm',
      },
    },
  };
  const email = {
    parsed: {
      attachments: [
        {
          filename: 'prescription.png',
          content_type: 'image/png',
          part_index: 0,
          size_bytes: 2,
          sha256: 'b'.repeat(64),
        },
      ],
    },
  };
  const action = actions.prepareAction(input, email, config);
  assert.equal(action.attachments.length, 0);
  assert.equal(action.evidence.length, 1);
  assert.equal(actions.requiresApproval(action), true);
  assert.notEqual(
    await actionHash(action),
    await actionHash({
      ...action,
      evidence: [{ ...action.evidence[0], sha256: 'd'.repeat(64) }],
    }),
  );
  assert.throws(
    () =>
      actions.prepareAction(
        { ...input, action: { ...input.action, body_text: 'Changed' } },
        email,
        config,
      ),
    /invalid_completion/,
  );
});
