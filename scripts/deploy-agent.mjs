// Credentials come from a private environment file. Blaxel authentication uses
// the logged-in CLI account; the sandbox never receives a Primitive API key.
import { SandboxInstance } from '@blaxel/core';
import fs from 'node:fs/promises';
import { createAgentArchive } from './lib/agent-archive.mjs';

const deploymentFile = new URL(
  '../deployment/support-inbox.json',
  import.meta.url,
);

async function prepareRuntime(sandbox) {
  const archive = await createAgentArchive(agentEntry);
  await sandbox.fs.writeBinary('/tmp/primitive-agent.zip', archive.toBuffer());

  const preparation = await sandbox.process.exec({
    name: 'prepare-agent-' + Date.now(),
    command: [
      'mkdir -p ' +
        releaseDirectory +
        ' ' +
        stateDirectory +
        ' /blaxel/email-agent-config',
      'chmod 700 ' + stateDirectory + ' /blaxel/email-agent-config',
      'python3 -m zipfile -e /tmp/primitive-agent.zip ' + releaseDirectory,
      'cp ' +
        releaseDirectory +
        '/package.json ' +
        releaseDirectory +
        '/package-lock.json /blaxel/email-agent/',
      'npm install --prefix /blaxel/email-agent --omit=dev --no-audit --no-fund',
    ].join(' && '),
    workingDir: '/blaxel',
    waitForCompletion: true,
    timeout: 55,
  });

  if (preparation.exitCode !== 0) {
    throw new Error('Dependency installation failed');
  }
}

async function configureRuntime(sandbox) {
  const config = [
    'ANTHROPIC_API_KEY=' + process.env.ANTHROPIC_API_KEY,
    'AGENT_BRIDGE_SECRET=' + process.env.AGENT_BRIDGE_SECRET,
    'TYPESAFE_API_KEY=' + process.env.TYPESAFE_API_KEY,
    'AGENT_STATE_DIR=' + stateDirectory,
    'AGENT_MODEL=' + (process.env.AGENT_MODEL || 'claude-sonnet-5-5'),
    ...(agentEntry === 'agents/support/server.mjs'
      ? ['SUPPORT_CUSTOMER_EMAIL=' + previousDeployment.allowed_customers[0]]
      : []),
    ...(previousDeployment.order_id
      ? ['SUPPORT_ORDER_ID=' + previousDeployment.order_id]
      : []),
    'AGENT_PORT=8000',
    '',
  ].join('\n');

  await sandbox.fs.write('/blaxel/email-agent-config/agent.env', config);
  await sandbox.process.exec({
    name: 'protect-agent-config-' + Date.now(),
    command: 'chmod 600 /blaxel/email-agent-config/agent.env',
    waitForCompletion: true,
  });
}

async function startRuntime(sandbox, previousProcessName) {
  if (previousProcessName) {
    const previousProcess = await sandbox.process.get(previousProcessName);
    if (previousProcess.status === 'running') {
      await sandbox.process.stop(previousProcessName);
    }
  }

  const processName = 'primitive-email-agent-' + Date.now();
  await sandbox.process.exec({
    name: processName,
    command:
      'node --env-file=/blaxel/email-agent-config/agent.env ' + agentEntry,
    workingDir: releaseDirectory,
    waitForPorts: [8000],
    restartOnFailure: true,
    maxRestarts: 3,
  });
  return processName;
}

const previousDeployment = JSON.parse(
  await fs.readFile(deploymentFile, 'utf8'),
);
const agentEntry =
  previousDeployment.agent_entry || 'agents/support/server.mjs';
const releaseDirectory = '/blaxel/email-agent/releases/' + Date.now();
if (
  previousDeployment.state_namespace !== undefined &&
  !/^[a-z0-9][a-z0-9-]{0,39}$/.test(previousDeployment.state_namespace)
)
  throw new Error('invalid_state_namespace');
const stateDirectory =
  '/blaxel/email-agent-state' +
  (previousDeployment.state_namespace
    ? '/' + previousDeployment.state_namespace
    : '');
for (const filename of [agentEntry]) {
  if (!/^agents\/[a-z0-9_-]+\/[a-z0-9_.-]+$/.test(filename))
    throw new Error('invalid_application_path');
}
if (
  agentEntry === 'agents/support/server.mjs' &&
  !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(previousDeployment.order_id || '')
)
  throw new Error('A configured order_id is required');
if (process.argv.includes('--dry-run')) {
  const archive = await createAgentArchive(agentEntry);
  console.log({
    status: 'prepared',
    sandbox: previousDeployment.sandbox,
    files: archive.getEntries().length,
    bytes: archive.toBuffer().length,
    remote_changes: false,
  });
  process.exit(0);
}
for (const key of [
  'ANTHROPIC_API_KEY',
  'AGENT_BRIDGE_SECRET',
  'TYPESAFE_API_KEY',
]) {
  if (!process.env[key] || /[\r\n]/.test(process.env[key])) {
    throw new Error(key + ' is required');
  }
}

if (!previousDeployment.allowed_customers?.length)
  throw new Error('At least one allowed customer is required');
if (
  agentEntry === 'agents/support/server.mjs' &&
  previousDeployment.allowed_customers.length !== 1
)
  throw new Error('The support agent requires one configured customer');
if (/[\r\n]/.test(process.env.AGENT_MODEL || ''))
  throw new Error('invalid_agent_model');

const sandbox = await SandboxInstance.get(previousDeployment.sandbox);
if (sandbox.status !== 'DEPLOYED') {
  throw new Error(
    'The configured sandbox is not deployed. Restore it before deployment.',
  );
}

await prepareRuntime(sandbox);
await configureRuntime(sandbox);
const processName = await startRuntime(
  sandbox,
  previousDeployment.sandbox_process,
);
await fs.writeFile(
  deploymentFile,
  JSON.stringify(
    {
      ...previousDeployment,
      sandbox_process: processName,
      release_directory: releaseDirectory,
    },
    null,
    2,
  ),
);

const health = await fetch(previousDeployment.agent_url + '/health');
if (!health.ok) {
  throw new Error('Agent health check failed');
}
console.log({
  status: 'running',
  sandbox: previousDeployment.sandbox,
  process: processName,
  health: await health.json(),
});
