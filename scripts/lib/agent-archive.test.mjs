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

test('container COPY and build context include every local runtime dependency', async () => {
  const dockerfile = await fs.readFile(
    new URL('Dockerfile', projectRoot),
    'utf8',
  );
  const ignore = (
    await fs.readFile(new URL('.dockerignore', projectRoot), 'utf8')
  )
    .trim()
    .split('\n');
  // This recipe deliberately uses an allowlist, simple relative COPY sources,
  // and one exclusion. Fail on syntax changes rather than guessing Docker rules.
  assert.equal(ignore[0], '*');
  assert.equal(ignore.at(-1), '**/*.test.mjs');
  assert.ok(ignore.slice(1, -1).every((line) => line.startsWith('!')));
  const allowed = ignore.slice(1, -1).map((line) => line.slice(1));
  const copied = [
    ...dockerfile.matchAll(/^COPY (?:--chown=\S+ )?(.+)$/gm),
  ].flatMap(([, args]) => args.split(' ').slice(0, -1));
  const archive = await createAgentArchive();
  for (const { entryName: name } of archive.getEntries()) {
    assert.ok(
      copied.some((source) => name === source || name.startsWith(source + '/')),
      'Missing COPY: ' + name,
    );
    assert.ok(
      allowed.some((pattern) =>
        pattern.endsWith('/**')
          ? name.startsWith(pattern.slice(0, -2))
          : name === pattern,
      ),
      'Excluded build context: ' + name,
    );
    assert.ok(!name.endsWith('.test.mjs'));
  }
});
