import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './bundles.mjs';

// Package only the entrypoint and its local import graph, preserving the source
// tree. A different application can use the same deployer with another entrypoint.
export async function createAgentArchive(
  entry = 'agents/support/server.mjs',
  assets = [],
) {
  const root = fileURLToPath(projectRoot);
  const archive = new AdmZip();
  const visited = new Set();
  async function add(name) {
    if (visited.has(name)) return;
    if (
      name !== path.posix.normalize(name) ||
      name.startsWith('../') ||
      path.isAbsolute(name)
    )
      throw new Error('archive_path_outside_project');
    visited.add(name);
    const source = await fs.readFile(path.join(root, name));
    archive.addFile(name, source);
    if (!name.endsWith('.mjs')) return;
    for (const [, specifier] of source
      .toString()
      .matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('.'))
        await add(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(name), specifier),
          ),
        );
    }
  }
  await add('package.json');
  await add('package-lock.json');
  await add(entry);
  for (const asset of assets) await add(asset);
  return archive;
}
