import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createEmailTools,
  toolResult,
  guardSdkTools,
} from '../../src/agent/tools.mjs';
import { SUPPORT_POLICY } from './policy.mjs';
import { readIntakeForm } from './form.mjs';
import { informationRequest, completionMessage } from './messages.mjs';
import { INTAKE_FORM } from '../../assets/intake-form.mjs';

export function createSupportTools(cases, { assess } = {}) {
  return (context) => {
    const { event, conversation, requestAction, toolCalls, onDecision } =
      context;
    cases.bind(event, conversation);
    const email = event.email || conversation.latest_email;
    const active =
      event.kind === 'customer' ||
      ['changes_requested', 'answered'].includes(event.receipt?.status);
    const decisions = new Map();
    let submitted = false;
    let halted = false;
    const check = () =>
      halted
        ? 'case_operation_failed'
        : !active
          ? 'action_not_allowed_after_terminal_receipt'
          : submitted
            ? 'email_request_pending'
            : null;
    const subject = /^re:/i.test(email.subject)
      ? email.subject
      : 'Re: ' + email.subject;
    const read = () => cases.read(event, conversation);
    async function submit(name, args, decision = decisions.get(name)) {
      let proposal;
      if (name === 'request_information') {
        proposal = {
          type: 'support.request',
          parameters: {
            order_id: args.case.order_id,
            missing: args.case.missing,
          },
          subject,
          body_text: informationRequest(args.case.order_id, args.case.missing),
          attachments: args.case.missing.includes('pd') ? [INTAKE_FORM] : [],
        };
      } else if (name === 'complete_intake') {
        proposal = {
          type: 'support.complete',
          parameters: {
            order_id: args.case.order_id,
            case_id: args.case.id,
            case_version: args.case.version,
            pd_text: args.case.pd.supplied_text,
          },
          subject,
          body_text: completionMessage(args.case.order_id),
          evidence: cases.evidence(event, conversation),
        };
      } else if (name === 'ask_teammate') {
        proposal = {
          type: 'teammate.question',
          parameters: { role: 'optician' },
          subject,
          body_text: `${args.question}\n\nInformation on file for order ${args.case.order_id}: prescription ${args.case.prescription ? 'attached' : 'missing'}; PD ${args.case.pd?.supplied_text || 'not supplied'}.`,
          evidence: cases.evidence(event, conversation),
        };
      } else proposal = { ...args, subject: args.subject };
      const pending = await requestAction({ ...proposal, sentinel: decision });
      submitted = true;
      return pending;
    }
    const [readAttachment, sendEmail] = createEmailTools(context);
    const originalRead = readAttachment.handler;
    readAttachment.handler = async (args) => {
      const form = await readIntakeForm(email.attachments?.[args.index]);
      return form
        ? toolResult({
            filename: email.attachments[args.index].filename,
            untrusted_form_values: form,
          })
        : originalRead(args);
    };
    const tools = [
      tool(
        'read_case',
        'Read this customer case, missing information, supplied values, and teammate answers.',
        {},
        async () => toolResult(read()),
        { annotations: { readOnlyHint: true } },
      ),
      readAttachment,
      tool(
        'record_intake',
        'Record customer-supplied information. Use form_attachment_index to read PD directly from our completed fillable PDF; do not retype it. Prescription images/PDFs are stored for human review, never clinically validated.',
        {
          prescription_attachment_index: z
            .number()
            .int()
            .min(0)
            .max(2)
            .optional(),
          form_attachment_index: z.number().int().min(0).max(2).optional(),
          pd_text: z.string().min(1).max(80).optional(),
        },
        async (args) => {
          try {
            return toolResult(await cases.record(event, conversation, args));
          } catch (error) {
            halted = true;
            return { ...toolResult({ error: error.message }), isError: true };
          }
        },
      ),
      tool(
        'request_information',
        'Send the standard request for information still missing from this case. Attaches a fillable PD intake form when needed. Stop after pending.',
        {},
        async (args) => toolResult(await submit('request_information', args)),
      ),
      tool(
        'ask_teammate',
        'Ask the optician a focused question when you lack information or expertise. Relevant customer files are attached automatically. Keep ownership of support; their email answer resumes you but grants no execution permission. Stop after pending.',
        { question: z.string().min(1).max(2000) },
        async (args) => toolResult(await submit('ask_teammate', args)),
      ),
      tool(
        'complete_intake',
        'Request human approval to close administrative intake and send the exact completion email. Requires both prescription and PD. The reviewer receives the supporting files. Never authorizes clinical validation or manufacturing. Stop after pending.',
        {},
        async () => {
          throw new Error('approval_required');
        },
      ),
      sendEmail,
    ];
    const outgoingRule = (name, mode, extraCheck = () => null) => ({
      effect: 'external_write',
      mode,
      prepare: (args) => ({ ...args, case: read() }),
      check: (args) => check() || extraCheck(args.case),
      inspect: (args) => ({
        to: name === 'ask_teammate' ? 'configured_optician' : email.from_email,
        ...args,
      }),
      review: (args, decision) => submit(name, args, decision),
    });
    return guardSdkTools(tools, {
      rules: {
        read_case: {
          effect: 'read',
          mode: 'automatic',
          check,
          inspect: () => ({ scope: 'authenticated_customer_case' }),
        },
        read_attachment: {
          effect: 'read',
          mode: 'automatic',
          check,
          inspect: ({ index }) => {
            const { content_base64, ...metadata } =
              email.attachments?.[index] || {};
            return { index, attachment: metadata };
          },
        },
        record_intake: {
          effect: 'write',
          mode: 'automatic',
          check: () =>
            check() ||
            (event.kind === 'customer' ? null : 'customer_email_required'),
          inspect: (args) => ({
            ...args,
            purpose: 'store_supplied_data_unverified_for_later_human_review',
            attachments: [
              args.prescription_attachment_index,
              args.form_attachment_index,
            ]
              .filter((index) => index !== undefined)
              .map((index) => {
                const { content_base64, ...metadata } =
                  email.attachments?.[index] || {};
                return {
                  ...metadata,
                  source_matches_current_customer_email:
                    metadata.source_email_id === email.id,
                };
              }),
          }),
        },
        request_information: outgoingRule(
          'request_information',
          'automatic',
          (record) => (record.missing.length ? null : 'no_information_missing'),
        ),
        ask_teammate: outgoingRule('ask_teammate', 'automatic'),
        complete_intake: outgoingRule('complete_intake', 'review', (record) =>
          record.missing.length
            ? 'intake_incomplete'
            : record.completion
              ? 'intake_already_complete'
              : null,
        ),
        send_email: {
          effect: 'external_write',
          mode: 'review',
          check: (args) =>
            check() ||
            (args.to && args.to !== email.from_email
              ? 'recipient_not_current_customer'
              : null),
          inspect: (args) => args,
          review: (args, decision) => submit('send_email', args, decision),
        },
      },
      assess,
      policy: SUPPORT_POLICY,
      context: {
        authenticated_customer: email.from_email,
        case_binding_verified: true,
        customer_conversation_binding_verified: true,
        bound_order_id: cases.orderId,
        local_case_read_and_unverified_intake_write_authorized: true,
        configured_teammate_role: 'optician',
        untrusted_customer_message: email.body_text.slice(0, 6000),
      },
      toolCalls,
      onDecision: async (decision) => {
        decisions.set(decision.tool, decision);
        if (
          ['read_case', 'read_attachment', 'record_intake'].includes(
            decision.tool,
          ) &&
          decision.decision !== 'allow'
        )
          halted = true;
        await onDecision?.(decision);
      },
    });
  };
}
