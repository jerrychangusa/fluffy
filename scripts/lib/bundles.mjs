import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const projectRoot = new URL('../../', import.meta.url);
const targets = {
  approval: 'src/functions/approval.mjs',
  inbox: 'src/functions/inbox.mjs',
};

async function buildFunction(name) {
  const outputFile = new URL(`dist/${name}.mjs`, projectRoot);
  await build({
    absWorkingDir: fileURLToPath(projectRoot),
    entryPoints: [targets[name]],
    outfile: fileURLToPath(outputFile),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: false,
    banner: { js: `// Generated. Rebuild with npm run build:${name}.` },
  });
  return fs.readFile(outputFile, 'utf8');
}

export const buildApprovalBundle = () => buildFunction('approval');
export const buildInboxBundle = () => buildFunction('inbox');
