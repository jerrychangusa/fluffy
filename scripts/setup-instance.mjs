import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeInstance, loadInstance } from './lib/instance-config.mjs';

const [action, directory, ...extra] = process.argv.slice(2);
if (!['init', 'check'].includes(action) || !directory || extra.length)
  throw new Error(
    'Usage: npm run setup -- init|check /absolute/private/instance-directory',
  );
if (!path.isAbsolute(directory))
  throw new Error('Use an absolute instance directory');
if (action === 'init') {
  await initializeInstance(directory);
  await fs.copyFile(
    new URL('../.env.example', import.meta.url),
    path.join(directory, 'runtime.env.example'),
    fs.constants.COPYFILE_EXCL,
  );
  await fs.chmod(path.join(directory, 'runtime.env.example'), 0o600);
  console.log(
    'Created local templates. Edit the JSON files, then run setup -- check. No remote resources changed.',
  );
} else {
  const { inbox } = await loadInstance({ FLUFFY_CONFIG_DIR: directory });
  // No keys are read and no provider requests are made by this command.
  console.log(
    JSON.stringify(
      {
        valid: true,
        remote_checked: false,
        runtime: {
          SUPPORT_CUSTOMER_ACCESS: inbox.customer_access || 'allowlist',
          SUPPORT_CUSTOMER_EMAIL:
            inbox.customer_access === 'authenticated'
              ? undefined
              : inbox.allowed_customers[0],
          SUPPORT_ORDER_ID: inbox.order_id,
        },
        next: 'Copy these runtime settings into your private runtime.env; configure provider keys separately.',
      },
      null,
      2,
    ),
  );
}
