/**
 * Bundle the API, worker, and PostgreSQL check into dist/runtime.
 * node_modules stay external so Linux native addons load from the server install.
 * Each process wrapper loads .env.local before the app bundle evaluates.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'runtime');
const extensions = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json'];

function resolveAlias(specifier) {
  const base = path.join(root, 'src', specifier.slice(2));
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of extensions) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  for (const ext of extensions) {
    const index = path.join(base, `index${ext}`);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

const aliasPlugin = {
  name: 'at-alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const resolved = resolveAlias(args.path);
      if (!resolved) return { errors: [{ text: `Cannot resolve ${args.path}` }] };
      return { path: resolved };
    });
  }
};

// Node ESM does not add .js for packages that ship extensionless files
// without an "exports" map. tsx can load those; the runtime bundle must not.
const esmExternalPlugin = {
  name: 'esm-external-extension',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('node:') || args.kind === 'entry-point') return null;
      const file = path.join(root, 'node_modules', `${args.path}.js`);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
      return { path: `${args.path}.js`, external: true };
    });
  }
};

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  jsx: 'automatic',
  sourcemap: false,
  legalComments: 'none',
  plugins: [aliasPlugin, esmExternalPlugin],
  loader: {
    '.css': 'empty',
    '.svg': 'text'
  },
  logLevel: 'info'
};

fs.mkdirSync(outDir, { recursive: true });

async function buildEntry(entry, outfile) {
  const result = await esbuild.build({
    ...shared,
    entryPoints: [entry],
    outfile,
    logLevel: 'silent'
  });
  const name = path.basename(outfile);
  if (result.warnings.length === 0) {
    console.log(`[bundle] ${name} warnings: 0`);
    return;
  }
  console.log(`[bundle] ${name} warnings: ${result.warnings.length}`);
  for (const warning of result.warnings) {
    const where = warning.location ? `${warning.location.file}:${warning.location.line}` : '';
    console.log(`  - ${warning.text}${where ? ` (${where})` : ''}`);
  }
}

await buildEntry(path.join(root, 'src', 'lib', 'load-env.ts'), path.join(outDir, 'load-env.mjs'));
await buildEntry(path.join(root, 'server', 'api', 'index.ts'), path.join(outDir, 'api-app.mjs'));
await buildEntry(path.join(root, 'server', 'worker', 'index.ts'), path.join(outDir, 'worker-app.mjs'));
await buildEntry(path.join(root, 'scripts', 'check-postgres.ts'), path.join(outDir, 'check-postgres-app.mjs'));

function writeWrapper(name, appFile) {
  const contents = `import { loadProjectEnv } from './load-env.mjs';

loadProjectEnv();
await import('./${appFile}');
`;
  fs.writeFileSync(path.join(outDir, name), contents);
}

writeWrapper('api.mjs', 'api-app.mjs');
writeWrapper('worker.mjs', 'worker-app.mjs');
writeWrapper('check-postgres.mjs', 'check-postgres-app.mjs');

fs.writeFileSync(
  path.join(outDir, 'BUILD.json'),
  `${JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      node: process.version,
      entries: ['api.mjs', 'worker.mjs', 'check-postgres.mjs']
    },
    null,
    2
  )}\n`
);

console.log(`[bundle] runtime written to ${outDir}`);
