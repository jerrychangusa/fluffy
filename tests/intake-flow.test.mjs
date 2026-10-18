import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { State } from '../src/agent/state.mjs';
import { AgentService } from '../src/agent/service.mjs';
import { createHarness } from '../src/agent/claude.mjs';
import { InboxBridge } from '../src/inbox/bridge.mjs';
import { ApprovalService } from '../src/approval/service.mjs';
import { QuestionService } from '../src/questions/service.mjs';
import { CaseStore } from '../agents/support/cases.mjs';
import { createSupportTools } from '../agents/support/tools.mjs';
import { supportActions } from '../agents/support/actions.mjs';
import { SYSTEM_PROMPT } from '../agents/support/prompt.mjs';
import {
  SUPPORT_POLICY,
  supportActionAssessment,
} from '../agents/support/policy.mjs';
import { assess, assessToolCall } from '../src/integrations/jev/client.mjs';
import { sha } from '../src/shared/crypto.mjs';
import { canonical } from '../src/shared/json.mjs';

const real = process.env.REAL_MODELS === '1';
const config = {
  requester_address: 'requester@agent.example',
  approval_address: 'approvals@agent.example',
  execution_address: 'executor@agent.example',
  customer_sender: 'support@agent.example',
  approver: 'reviewer@gmail.com',
  allowed_recipients: ['customer@gmail.com'],
  allowed_customers: ['customer@gmail.com'],
  signing_domain: 'agent.example',
  signing_selector: 'selector',
  teammates: { optician: 'reviewer@gmail.com' },
};
const allow = async () => ({
  source: 'jev',
  choice: 'allow',
  confidence: 0.99,
});

// Optional live-model check still uses an isolated mail transport. It never sends
// customer data or approval commands through a real person's mailbox.
test(
  'customer attachment → fillable form → teammate answer → exact approval → completed intake',
  { timeout: real ? 240000 : 20000 },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'intake-flow-'));
    const state = new State(directory);
    t.after(() => {
      state.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const cases = new CaseStore({
      state,
      customerEmail: 'customer@gmail.com',
      orderId: '1042',
    });
    const decisions = [];
    const createTools = createSupportTools(cases, {
      assess: real
        ? async (call) => {
            const decision = await assessToolCall(
              call,
              process.env.TYPESAFE_API_KEY,
            );
            decisions.push({ tool: call.tool.name, ...decision });
            return decision;
          }
        : allow,
    });
    const run = real
      ? createHarness({
          directory,
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: 'claude-sonnet-5-5',
          createTools,
          systemPrompt: SYSTEM_PROMPT,
        })
      : async (context) => {
          context.onSession('session-1');
          const tools = createTools(context);
          const call = (name, args = {}) =>
            tools.find((tool) => tool.name === name).handler(args);
          if (context.event.kind === 'customer') {
            await call('read_case');
            await call('read_attachment', { index: 0 });
            if (
              context.event.email.attachments[0].content_type ===
              'application/pdf'
            ) {
              await call('record_intake', { form_attachment_index: 0 });
              await call('ask_teammate', {
                question:
                  'Is the prescription date acceptable for this intake?',
              });
            } else {
              await call('record_intake', { prescription_attachment_index: 0 });
              await call('request_information');
            }
          } else if (context.event.receipt.status === 'answered')
            await call('complete_intake');
          return { resumed: !!context.conversation.session_id };
        };
    const agent = new AgentService({
      state,
      run,
      onReceipt: (event, conversation) =>
        cases.receiveReceipt(event, conversation),
    });
    const values = new Map();
    const store = {
      async get(id) {
        return structuredClone(values.get(id) || null);
      },
      async put(id, value, condition = {}) {
        const previous = values.get(id);
        if (
          (condition.if_absent && previous) ||
          (condition.if_version && previous?.version !== condition.if_version)
        )
          throw Object.assign(new Error('conflict'), { status: 409 });
        values.set(id, {
          value: canonical(structuredClone(value)),
          version: (previous?.version || 0) + 1,
        });
      },
    };
    const emails = new Map(),
      sent = [],
      parts = new Map();
    async function email(
      from,
      recipient,
      subject,
      body,
      attachments = [],
      extra = {},
    ) {
      const id = crypto.randomUUID();
      const metadata = [];
      for (const [index, attachment] of attachments.entries()) {
        const bytes = Buffer.from(attachment.content_base64, 'base64');
        parts.set(id + ':' + index, bytes);
        metadata.push({
          filename: attachment.filename,
          content_type: attachment.content_type,
          size_bytes: bytes.length,
          sha256: await sha(bytes),
          part_index: index,
        });
      }
      const message = {
        id,
        thread_id: 'case-thread',
        from_email: from,
        recipient,
        subject,
        message_id: `<${id}@example.com>`,
        received_at: new Date().toISOString(),
        status: 'completed',
        parsed: { status: 'complete', body_text: body, attachments: metadata },
        auth: {
          dmarc: 'pass',
          dmarcDkimAligned: true,
          dkimSignatures: [
            {
              result: 'pass',
              aligned: true,
              domain: from.split('@')[1],
              selector: 'selector',
            },
          ],
        },
        ...extra,
      };
      emails.set(id, message);
      return message;
    }
    const mail = {
      base64: (bytes) => Buffer.from(bytes).toString('base64'),
      attachment: async (id, index) => parts.get(id + ':' + index),
      async send(body, key) {
        let previous = sent.find((row) => row.key === key);
        if (!previous) {
          previous = {
            id: crypto.randomUUID(),
            key,
            body,
            status: 'delivered',
            incoming: await email(
              body.from,
              body.to,
              body.subject,
              body.body_text,
              body.attachments,
            ),
          };
          sent.push(previous);
        }
        return previous;
      },
      async lookup(key) {
        return sent.filter((row) => row.key === key);
      },
      async detail(id) {
        return sent.find((row) => row.id === id);
      },
      async wake() {
        return { wire_id: 'wake', step_id: 'step', send_id: 'send' };
      },
    };
    const api = async (route) => emails.get(route.split('/').at(-1));
    const inbox = new InboxBridge({
      api,
      store,
      mail,
      config,
      invoke: async (event) => {
        const result = await agent.handle(event);
        if (real)
          t.diagnostic(
            JSON.stringify({
              stage: 'agent_event',
              event: event.kind,
              status: result.status,
              tools: result.tool_calls,
              cost_usd: result.cost_usd,
            }),
          );
        return result;
      },
    });
    const approvals = new ApprovalService({
      store,
      mail,
      config,
      ...supportActions('1042'),
      assess: real
        ? (action) =>
            assessToolCall(
              supportActionAssessment(action),
              process.env.TYPESAFE_API_KEY,
            )
        : allow,
    });
    const questions = new QuestionService({
      store,
      mail,
      config,
      assess: real
        ? (action) =>
            assessToolCall(
              {
                tool: {
                  name: 'ask_teammate',
                  effect: 'external_write',
                  approval: 'automatic',
                },
                arguments: action,
                policy: SUPPORT_POLICY,
                context: {
                  configured_teammate_verified: true,
                  stage: 'internal_question_held_before_delivery',
                },
              },
              process.env.TYPESAFE_API_KEY,
            )
        : allow,
    });
    const last = (predicate) => sent.filter(predicate).at(-1);
    const request = () =>
      last((row) => row.body.to === config.approval_address).incoming;
    const receipt = () =>
      last((row) => row.body.to === config.requester_address).incoming;
    async function execute(record) {
      const current = await approvals.record(record.id);
      const envelope = {
        interaction_version: 1,
        protocol: 'wake.dispatch',
        protocol_version: 1,
        step: 'dispatch',
        interaction_id: current.wake.wire_id,
        step_id: current.wake.step_id,
        payload: {
          command: 'resume_request',
          args: {
            request_id: current.id,
            action_hash: current.hash,
            nonce: current.wake.token,
          },
        },
      };
      const bytes = Buffer.from(JSON.stringify(envelope));
      const wake = await email(
        config.approval_address,
        config.execution_address,
        'Wake',
        'Wake',
        [
          {
            filename: 'interaction.json',
            content_type: 'application/json',
            content_base64: bytes.toString('base64'),
          },
        ],
        { message_id: '<primitive-direct-send@primitive.email>' },
      );
      assert.equal((await approvals.handleEmail(wake)).status, 'executed');
      return inbox.receive(receipt());
    }
    const rx = {
      filename: 'prescription.png',
      content_type: 'image/png',
      content_base64: (
        await fs.readFile(
          new URL('./fixtures/prescription.png', import.meta.url),
        )
      ).toString('base64'),
    };
    const initial = await inbox.receive(
      await email(
        'customer@gmail.com',
        config.customer_sender,
        'My glasses order',
        'Here is my prescription for order 1042. What else do you need?',
        [rx],
      ),
    );
    let record = await approvals.handleEmail(request());
    if (real)
      t.diagnostic(
        JSON.stringify({
          stage: 'form_request',
          agent_status: initial.status,
          tool_calls: initial.tool_calls,
          gateway: initial.gateway_decisions,
          executor: record.assessment,
          resource: record.action.resource,
        }),
      );
    assert.equal(
      record.status,
      'approved',
      'standard form request should be policy-authorized',
    );
    await execute(record);
    const formMessage = last((row) => row.body.from === config.customer_sender);
    assert.equal(
      formMessage.body.attachments[0].content_type,
      'application/pdf',
    );
    const form = await PDFDocument.load(
      Buffer.from(formMessage.body.attachments[0].content_base64, 'base64'),
    );
    form.getForm().getTextField('order_reference').setText('1042');
    form.getForm().getTextField('pd_text').setText('31 / 31');
    const filled = {
      filename: 'Completed intake (1).pdf',
      content_type: 'application/pdf',
      content_base64: Buffer.from(await form.save()).toString('base64'),
    };
    await inbox.receive(
      await email(
        'customer@gmail.com',
        config.customer_sender,
        'Re: My glasses order',
        'Here is my completed form. Please ask your optician whether the prescription date is acceptable before proceeding.',
        [filled],
        { reply_to_sent_email_id: formMessage.id },
      ),
    );
    const question = await questions.handleEmail(request());
    assert.equal(question.status, 'pending');
    const questionEmail = last((row) => row.body.to === config.approver);
    assert.equal(questionEmail.body.attachments.length, 2);
    const answer = await email(
      config.approver,
      config.approval_address,
      'Re: ' + questionEmail.body.subject,
      'The document is acceptable for administrative intake. Proceed with the supplied PD. Clinical review will follow.',
      [],
      { reply_to_sent_email_id: questionEmail.id },
    );
    await questions.handleEmail(answer);
    const resumed = await inbox.receive(receipt());
    record = await approvals.handleEmail(request());
    assert.equal(record.status, 'pending');
    assert.equal(
      sent.filter((row) => row.body.from === config.customer_sender).length,
      1,
    );
    const pendingCase = cases.read(
      {
        conversation_id: initial.conversation_id,
        email: { from_email: 'customer@gmail.com' },
      },
      {},
    );
    assert.equal(pendingCase.pd.supplied_text, '31 / 31');
    assert.equal(pendingCase.completion, null);
    const approvalEmail = last((row) => row.body.to === config.approver);
    assert.equal(approvalEmail.body.attachments.length, 2);
    const approved = await email(
      config.approver,
      config.approval_address,
      'Re: ' + approvalEmail.body.subject,
      'APPROVE ' + record.id,
      [],
      { reply_to_sent_email_id: approvalEmail.id },
    );
    await approvals.handleEmail(approved);
    const done = await execute(record);
    const delivery = last((row) => row.body.from === config.customer_sender);
    assert.equal(delivery.body.attachments.length, 0);
    assert.equal(delivery.body.body_text, record.action.body_text);
    assert.equal(
      cases.read(
        {
          conversation_id: initial.conversation_id,
          email: { from_email: 'customer@gmail.com' },
        },
        {},
      ).status,
      'intake_complete',
    );
    await inbox.receive(receipt());
    assert.equal(
      sent.filter((row) => row.body.from === config.customer_sender).length,
      2,
    );
    if (real) {
      const evidence = {
        verified_at: new Date().toISOString(),
        surface:
          'local services; real Claude and Jev; isolated simulated email transport',
        external_email_sent: false,
        model: 'claude-sonnet-5-5',
        initial,
        resumed,
        final: done,
        decisions,
        customer_message: delivery.body.body_text,
        pdf_pd_extracted: pendingCase.pd.supplied_text,
        review_only_files_excluded: true,
        customer_send_count: 2,
      };
      await fs.mkdir(new URL('../evidence/', import.meta.url), {
        recursive: true,
      });
      await fs.writeFile(
        new URL('../evidence/intake-live-models.json', import.meta.url),
        JSON.stringify(
          evidence,
          (key, value) => (key === 'content_base64' ? undefined : value),
          2,
        ) + '\n',
      );
    }
  },
);
