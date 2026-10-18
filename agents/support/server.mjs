import { State } from '../../src/agent/state.mjs';
import { AgentService } from '../../src/agent/service.mjs';
import { createHarness } from '../../src/agent/claude.mjs';
import { createAgentServer } from '../../src/agent/http.mjs';
import { CaseStore } from './cases.mjs';
import { createSupportTools } from './tools.mjs';
import { SYSTEM_PROMPT } from './prompt.mjs';
import { assessToolCall } from '../../src/integrations/jev/client.mjs';
import { createPrimitiveClock } from '../../src/integrations/primitive/clock.mjs';

const directory = process.env.AGENT_STATE_DIR;
const secret = process.env.AGENT_BRIDGE_SECRET;
const port = Number(process.env.AGENT_PORT || 8000);

if (!secret) {
  throw new Error('AGENT_BRIDGE_SECRET required');
}
if (!directory) throw new Error('AGENT_STATE_DIR required');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('invalid_agent_port');
}

const state = new State(directory);
const clock = createPrimitiveClock();
const cases = new CaseStore({
  state,
  now: clock.now,
  customerEmail: process.env.SUPPORT_CUSTOMER_EMAIL,
  customerAccess: process.env.SUPPORT_CUSTOMER_ACCESS || 'allowlist',
  orderId: process.env.SUPPORT_ORDER_ID,
});
const run = createHarness({
  directory,
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.AGENT_MODEL || 'sonnet',
  createTools: createSupportTools(cases, {
    assess: (call) => assessToolCall(call, process.env.TYPESAFE_API_KEY),
  }),
  systemPrompt: SYSTEM_PROMPT,
});
const service = new AgentService({
  state,
  now: clock.now,
  run,
  onReceipt: (event, conversation) => cases.receiveReceipt(event, conversation),
});
const server = createAgentServer({
  service,
  secret,
  modelReady: !!process.env.ANTHROPIC_API_KEY,
  policyReady: !!process.env.TYPESAFE_API_KEY,
  clock,
});

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ kind: 'ready', port }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => {
      state.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 190000).unref();
  });
}
