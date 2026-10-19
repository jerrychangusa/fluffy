import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configFile,
  initializeInstance,
  loadInstance,
  validateInstance,
} from './instance-config.mjs';

async function fixture() {
  const approval = JSON.parse(
    await fs.readFile(
      new URL('../../deployment/approval.example.json', import.meta.url),
    ),
  );
  const inbox = JSON.parse(
    await fs.readFile(
      new URL('../../deployment/support-inbox.example.json', import.meta.url),
    ),
  );
  approval.function_id = '12345678-1234-4000-8000-123456789012';
  inbox.function_id = '12345678-1234-4000-8000-123456789013';
  for (const key of [
    'approval_address',
    'execution_address',
    'requester_address',
    'customer_sender',
  ])
    approval[key] = approval[key].replace('your-domain', 'owned');
  approval.approver = 'reviewer@owned.test';
  approval.teammates = { optician: 'reviewer@owned.test' };
  approval.allowed_recipients = ['customer@owned.test'];
  approval.signing_selector = 'owned-selector';
  inbox.allowed_customers = ['customer@owned.test'];
  inbox.agent_url = 'https://agent.owned.test';
  return { approval, inbox };
}

test('instance validation accepts explicit resources without network or credentials', async () => {
  assert.equal(validateInstance(await fixture()).inbox.order_id, '1042');
});
test('rejects mixed instance settings and unsafe/example targets', async () => {
  const changes = [
    (x) => {
      delete x.approval.teammates;
    },
    (x) => {
      x.approval.teammates.optician = 'reviewer@example.com';
    },
    (x) => {
      x.inbox.function_id = x.approval.function_id;
    },
    (x) => {
      x.inbox.function_id = '00000000-0000-4000-a000-000000000002';
    },
    (x) => {
      x.inbox.customer_access = 'authenticated';
    },
    (x) => {
      x.inbox.allowed_customers = ['other@owned.test'];
    },
    (x) => {
      x.inbox.allowed_customers.push('other@owned.test');
    },
    (x) => {
      x.approval.execution_address = x.approval.approval_address;
    },
    (x) => {
      x.inbox.agent_url = 'https://secret@agent.owned.test';
    },
    (x) => {
      x.approval.approver = 'reviewer@example.com';
    },
  ];
  for (const change of changes) {
    const value = await fixture();
    change(value);
    assert.throws(() => validateInstance(value));
  }
});
test('bootstrap is private, refuses overwrite, and selects isolated config directory', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fluffy-setup-'));
  try {
    const directory = path.join(temp, 'instance');
    await initializeInstance(directory);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    const env = { FLUFFY_CONFIG_DIR: directory };
    assert.equal(
      configFile('approval.json', env),
      path.join(directory, 'approval.json'),
    );
    assert.equal(
      (await fs.stat(configFile('approval.json', env))).mode & 0o777,
      0o600,
    );
    await assert.rejects(initializeInstance(directory), { code: 'EEXIST' });
    await assert.rejects(loadInstance(env));
    const valid = await fixture();
    for (const [name, value] of [
      ['approval', valid.approval],
      ['support-inbox', valid.inbox],
    ])
      await fs.writeFile(
        configFile(name + '.json', env),
        JSON.stringify(value),
      );
    assert.deepEqual(await loadInstance(env), valid);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('setup CLI and all deploy dry runs use isolated explicit config without credentials', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const root = new URL('../../', import.meta.url);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fluffy-cli-'));
  const directory = path.join(temp, 'instance');
  const env = { PATH: process.env.PATH, FLUFFY_CONFIG_DIR: directory };
  const invoke = (file, args = []) =>
    run(process.execPath, [file, ...args], { cwd: root, env, timeout: 30000 });
  try {
    await invoke('scripts/setup-instance.mjs', ['init', directory]);
    await assert.rejects(
      invoke('scripts/setup-instance.mjs', ['check', directory]),
    );
    const valid = await fixture();
    for (const [name, value] of [
      ['approval', valid.approval],
      ['support-inbox', valid.inbox],
    ])
      await fs.writeFile(
        configFile(name + '.json', env),
        JSON.stringify(value),
      );
    const checked = JSON.parse(
      (await invoke('scripts/setup-instance.mjs', ['check', directory])).stdout,
    );
    assert.equal(checked.remote_checked, false);
    assert.equal(checked.runtime.SUPPORT_CUSTOMER_EMAIL, 'customer@owned.test');
    for (const name of ['approval', 'inbox', 'agent']) {
      const result = await invoke(`scripts/deploy-${name}.mjs`, ['--dry-run']);
      assert.match(result.stdout, /remote_changes: false/);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
