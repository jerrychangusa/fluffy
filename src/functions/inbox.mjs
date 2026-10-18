import { emailFunction } from '../integrations/primitive/email-function.mjs';
import { createMemoryStore } from '../integrations/primitive/memories.mjs';
import { InboxBridge } from '../inbox/bridge.mjs';
import { createAgentClient } from '../inbox/agent-client.mjs';
import { inboxConfig } from '../shared/configuration.mjs';

export default emailFunction('inbox', (email, env, { api, mail }) => {
  const config = inboxConfig(JSON.parse(env.INBOX_CONFIG));
  const bridge = new InboxBridge({
    api,
    mail,
    store: createMemoryStore(api, 'inbox'),
    invoke: createAgentClient(config.agent_url, env.AGENT_BRIDGE_SECRET),
    config,
  });
  return bridge.receive(email);
});
