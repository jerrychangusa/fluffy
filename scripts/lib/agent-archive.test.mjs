import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAgentArchive } from './agent-archive.mjs';
import { projectRoot } from './bundles.mjs';

test('deployment archive preserves the complete runtime graph and excludes development files', async () => {
  const archive = await createAgentArchive();
  const names = archive.getEntries().map((entry) => entry.entryName);
  for (const name of [
    'agents/support/server.mjs',
    'src/agent/service.mjs',
    'src/agent/claude.mjs',
    'src/shared/attachments.mjs',
    'package.json',
    'package-lock.json',
  ])
    assert.ok(names.includes(name), name);
  assert.equal(
    names.some((name) => /test|deploy|archive|\.env|node_modules/.test(name)),
    false,
  );
  for (const name of names.filter((name) => name.endsWith('.mjs'))) {
    const source = archive.readAsText(name);
    assert.equal(source, await fs.readFile(new URL(name, projectRoot), 'utf8'));
    for (const [, localImport] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (localImport.startsWith('.'))
        assert.ok(
          names.includes(
            path.posix.normalize(
              path.posix.join(path.posix.dirname(name), localImport),
            ),
          ),
          name + ': ' + localImport,
        );
    }
  }
});

test('runtime archive includes the form asset and rejects paths outside the project', async () => {
  const archive = await createAgentArchive();
  assert.ok(archive.getEntry('assets/intake-form.mjs'));
  await assert.rejects(
    createAgentArchive('agents/support/server.mjs', ['../private.env']),
  );
});
