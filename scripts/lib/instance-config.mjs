import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvalConfig,
  inboxConfig,
  validEmailAddress,
} from '../../src/shared/configuration.mjs';

export function configFile(name, env = process.env) {
  const directory =
    env.FLUFFY_CONFIG_DIR ||
    fileURLToPath(new URL('../../deployment/', import.meta.url));
  return path.resolve(directory, name);
}

export async function loadInstance(env = process.env) {
  const approval = JSON.parse(
    await fs.readFile(configFile('approval.json', env), 'utf8'),
  );
  const inbox = JSON.parse(
    await fs.readFile(configFile('support-inbox.json', env), 'utf8'),
  );
  return validateInstance({ approval, inbox });
}

// Local consistency checks, not proof of ownership or provider readiness.
export function validateInstance({ approval, inbox }) {
  approvalConfig(approval);
  inboxConfig({ ...approval, ...inbox });
  for (const config of [approval, inbox]) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        config.function_id || '',
      ) ||
      config.function_id.startsWith('00000000-')
    )
      throw new Error('Set your own function_id for both Functions');
  }
  if (approval.function_id === inbox.function_id)
    throw new Error('Functions must have distinct IDs');
  if (
    (approval.customer_access || 'allowlist') !==
    (inbox.customer_access || 'allowlist')
  )
    throw new Error('customer_access must match');
  if (
    inbox.customer_access !== 'authenticated' &&
    (inbox.allowed_customers.length !== 1 ||
      !approval.allowed_recipients.includes(inbox.allowed_customers[0]))
  )
    throw new Error(
      'Support demo requires one customer also listed in allowed_recipients',
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(inbox.order_id || ''))
    throw new Error('Set a valid order_id');
  if (!validEmailAddress(approval.teammates?.optician))
    throw new Error('Set the optician teammate address');
  const addresses = [
    'approval_address',
    'execution_address',
    'requester_address',
    'customer_sender',
  ].map((key) => approval[key]);
  if (new Set(addresses).size !== 4)
    throw new Error('Use four distinct routing addresses');
  if (
    [
      ...addresses,
      approval.approver,
      ...Object.values(approval.teammates || {}),
      ...(inbox.allowed_customers || []),
      ...(approval.allowed_recipients || []),
      approval.signing_selector,
      inbox.agent_url,
    ].some((value) =>
      /your-domain|your-agent|replace-with|@example\.(com|org|net)/i.test(
        value,
      ),
    )
  )
    throw new Error(
      'Replace example addresses, signing selector and agent URL',
    );
  if (inbox.agent_entry && inbox.agent_entry !== 'agents/support/server.mjs')
    throw new Error('Own-instance setup supports the support agent entrypoint');
  return { approval, inbox };
}

export async function initializeInstance(directory) {
  // mkdir without recursive deliberately refuses existing directories: never
  // overwrite an existing instance or silently adopt its private configuration.
  await fs.mkdir(directory, { mode: 0o700 });
  for (const name of ['approval', 'support-inbox']) {
    const example = new URL(
      `../../deployment/${name}.example.json`,
      import.meta.url,
    );
    await fs.writeFile(
      path.join(directory, name + '.json'),
      await fs.readFile(example),
      { flag: 'wx', mode: 0o600 },
    );
  }
}
