import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('shared infrastructure has no dependency on an application', async () => {
  const root = fileURLToPath(new URL('./', import.meta.url));
  for (const name of await fs.readdir(root, { recursive: true })) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    if (name.startsWith('functions/')) continue; // Deployment composition roots wire applications to shared infrastructure.
    const filename = path.join(root, name);
    const source = await fs.readFile(filename, 'utf8');
    for (const [, specifier] of source.matchAll(
      /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g,
    )) {
      if (!specifier.startsWith('.')) continue;
      assert.ok(
        path.resolve(path.dirname(filename), specifier).startsWith(root),
        name + ' imports application code: ' + specifier,
      );
    }
  }
});
