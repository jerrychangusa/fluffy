import { createValidatedAction } from '../../src/approval/requests.mjs';
import { requireThat } from '../../src/shared/validation.mjs';
import { INTAKE_FORM_SHA256 } from '../../assets/intake-form.mjs';
import { informationRequest, completionMessage } from './messages.mjs';

// Trusted email executor adapter. It rebuilds fixed messages independently of
// the agent and pins the exact case snapshot and review evidence into approval.
export function supportActions(orderId) {
  return {
    prepareAction(input, email, config) {
      const action = input.action;
      if (action?.type === 'email.send')
        return createValidatedAction(input, email, config);
      requireThat(
        ['support.request', 'support.complete'].includes(action?.type),
        'unsupported_action',
      );
      requireThat(
        Object.keys(action).every((key) =>
          [
            'type',
            'parameters',
            'to',
            'subject',
            'body_text',
            'in_reply_to',
          ].includes(key),
        ),
        'unsupported_action_field',
      );
      const parameters = action.parameters;
      requireThat(parameters?.order_id === orderId, 'wrong_order');
      const { parameters: _, ...message } = action;
      const validated = createValidatedAction(
        { ...input, action: { ...message, type: 'email.send' } },
        email,
        config,
      );
      if (action.type === 'support.request') {
        requireThat(
          Object.keys(parameters).sort().join(',') === 'missing,order_id' &&
            Array.isArray(parameters.missing) &&
            parameters.missing.length > 0 &&
            parameters.missing.length <= 2 &&
            new Set(parameters.missing).size === parameters.missing.length &&
            parameters.missing.every((field) =>
              ['prescription', 'pd'].includes(field),
            ),
          'invalid_intake_request',
        );
        requireThat(
          validated.body_text ===
            informationRequest(orderId, parameters.missing),
          'information_template_changed',
        );
        const formNeeded = parameters.missing.includes('pd');
        requireThat(
          !validated.evidence?.length &&
            validated.attachments.length === (formNeeded ? 1 : 0) &&
            (!formNeeded ||
              validated.attachments[0].sha256 === INTAKE_FORM_SHA256),
          'intake_form_changed',
        );
        return {
          ...validated,
          resource: {
            kind: 'support_request',
            id: orderId,
            requires_approval: false,
            label: 'Request missing customer information',
          },
        };
      }
      requireThat(
        Object.keys(parameters).sort().join(',') ===
          'case_id,case_version,order_id,pd_text' &&
          /^[-a-zA-Z0-9]{1,80}$/.test(parameters.case_id || '') &&
          /^[a-f0-9]{64}$/.test(parameters.case_version || '') &&
          typeof parameters.pd_text === 'string' &&
          parameters.pd_text.length <= 80 &&
          /\d/.test(parameters.pd_text),
        'invalid_intake_snapshot',
      );
      requireThat(
        validated.body_text === completionMessage(orderId) &&
          validated.attachments.length === 0 &&
          validated.evidence?.length >= 1,
        'invalid_completion_packet',
      );
      return {
        ...validated,
        resource: {
          kind: 'support_intake',
          review_title: 'Review this intake',
          id: parameters.case_id,
          version: parameters.case_version,
          requires_approval: true,
          label: `Order ${orderId} · PD supplied: ${parameters.pd_text} · Confirm intake is complete`,
        },
      };
    },
    requiresApproval: (action) => action.resource?.kind !== 'support_request',
  };
}
