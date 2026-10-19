import { loadInstance } from './lib/instance-config.mjs';
import { buildApprovalBundle } from './lib/bundles.mjs';
import { adminApi, configureSecrets } from './lib/primitive-deployment.mjs';
import { approvalConfig } from '../src/shared/configuration.mjs';

const { approval, inbox: deployment } = await loadInstance();
const config = approvalConfig({ ...approval, order_id: deployment.order_id });
const code = await buildApprovalBundle();
if (process.argv.includes('--dry-run')) {
  console.log({
    status: 'prepared',
    function_id: config.function_id,
    bytes: Buffer.byteLength(code),
    remote_changes: false,
  });
} else {
  const api = adminApi();
  // Provider credentials remain in the existing Function secrets.
  await configureSecrets(api, config.function_id, {
    APPROVAL_CONFIG: JSON.stringify(config),
  });
  const deployed = await api('/functions/' + config.function_id, 'PUT', {
    code,
  });
  console.log({
    function_id: deployed.id,
    deploy_status: deployed.deploy_status,
  });
}
