import { emailFunction } from '../integrations/primitive/email-function.mjs';
import { createMemoryStore } from '../integrations/primitive/memories.mjs';
import { createWakeDispatcher } from '../integrations/primitive/wake.mjs';
import { verifyCustomerRequest } from '../integrations/primitive/customer.mjs';
import { ApprovalService } from '../approval/service.mjs';
import { QuestionService, questionReference } from '../questions/service.mjs';
import { assessToolCall } from '../integrations/jev/client.mjs';
import { supportActions } from '../../agents/support/actions.mjs';
import {
  SUPPORT_POLICY,
  supportActionAssessment,
} from '../../agents/support/policy.mjs';

// Composition root: both conversations and permissions use the existing inbox.
// Application rules enter here; the generic services know nothing about eyewear.
export default emailFunction('approval', async (email, env, { api, mail }) => {
  const config = JSON.parse(env.APPROVAL_CONFIG);
  let input;
  try {
    input = JSON.parse(email.parsed?.body_text);
  } catch {}
  if (
    email.recipient === config.approval_address &&
    ['question.request/1', 'permission.request/1'].includes(input?.protocol)
  )
    await verifyCustomerRequest(input, email, config, api);
  const question =
    email.recipient === config.approval_address &&
    (input?.protocol === 'question.request/1' ||
      !!questionReference(email.subject));
  const service = question
    ? new QuestionService({
        store: createMemoryStore(api, 'questions'),
        mail,
        config,
        assess: (action) =>
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
            env.TYPESAFE_API_KEY,
          ),
      })
    : new ApprovalService({
        store: createMemoryStore(api, 'approval'),
        mail: { ...mail, wake: createWakeDispatcher(api, config) },
        config,
        ...supportActions(config.order_id),
        assess: (action) =>
          assessToolCall(supportActionAssessment(action), env.TYPESAFE_API_KEY),
      });
  const result = await service.handleEmail(email);
  return { request_id: result.id, status: result.status };
});
