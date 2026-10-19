import { loadInstance } from './lib/instance-config.mjs';
import { buildInboxBundle } from './lib/bundles.mjs';
import { adminApi, configureSecrets } from './lib/primitive-deployment.mjs';
import { inboxConfig } from '../src/shared/configuration.mjs';

const { approval, inbox: deployment } = await loadInstance();
const config = inboxConfig({ ...approval, ...deployment });
const code = await buildInboxBundle();
if (process.argv.includes('--dry-run')) {
  console.log({
    status: 'prepared',
    function_id: deployment.function_id,
    bytes: Buffer.byteLength(code),
    remote_changes: false,
  });
} else {
  if (!process.env.AGENT_BRIDGE_SECRET)
    throw new Error('AGENT_BRIDGE_SECRET required');
  const api = adminApi();
  const response = await api('/routes');
  const routes = (response.items || response).filter((route) =>
    [config.customer_sender, config.requester_address].includes(route.pattern),
  );
  if (routes.length !== 2 || !routes.every((route) => route.enabled))
    throw new Error(
      'Required inbox routes are missing or disabled. Check native Primitive routing before deployment.',
    );
  await configureSecrets(api, deployment.function_id, {
    INBOX_CONFIG: JSON.stringify(config),
    AGENT_BRIDGE_SECRET: process.env.AGENT_BRIDGE_SECRET,
  });
  const deployed = await api('/functions/' + deployment.function_id, 'PUT', {
    code,
  });
  console.log({
    function_id: deployed.id,
    deploy_status: deployed.deploy_status,
    routes_enabled: true,
  });
}
