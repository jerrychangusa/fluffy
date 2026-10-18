import { buildApprovalBundle, projectRoot } from './lib/bundles.mjs';
import {
  adminApi,
  readConfig,
  configureSecrets,
} from './lib/primitive-deployment.mjs';
import { approvalConfig } from '../src/shared/configuration.mjs';

const application = await readConfig(
  new URL('deployment/support-inbox.json', projectRoot),
);
const config = approvalConfig({
  ...(await readConfig(new URL('deployment/approval.json', projectRoot))),
  order_id: application.order_id,
});
if (!config.function_id) throw new Error('function_id required');
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
