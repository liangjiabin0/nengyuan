import { spawnSync } from 'node:child_process';
import path from 'node:path';

const requested = Number(process.env.AI4ES_BUILD_MEMORY_MB || 8192);
const memoryMb = Number.isFinite(requested) && requested >= 4096 ? Math.floor(requested) : 8192;
const nextCli = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
const inherited = String(process.env.NODE_OPTIONS || '')
  .replace(/--max-old-space-size(?:=|\s+)\d+/g, '')
  .trim();
const nodeOptions = [inherited, `--max-old-space-size=${memoryMb}`].filter(Boolean).join(' ');

const buildAllRoutes = /^(?:1|true|yes)$/i.test(String(process.env.AI4ES_BUILD_ALL_ROUTES || ''));
const args = [nextCli, 'build', '--webpack'];
if (!buildAllRoutes) {
  // Production always runs the Hono API as a separate process. Do not bundle
  // the duplicate 98 App Router API adapters into the Web process; the
  // beforeFiles rewrite below forwards every /api request to Hono.
  args.push('--debug-build-paths=src/app/**/page.tsx,src/app/healthz/route.ts,src/app/datav-runtime/**/route.ts,src/app/datav-dc/**/route.ts');
}

console.log(`[build] Next.js Webpack heap limit: ${memoryMb} MB (override with AI4ES_BUILD_MEMORY_MB)`);
console.log(`[build] Route set: ${buildAllRoutes ? 'all Next routes' : 'split Web pages + /healthz (API runs in Hono)'}`);
const result = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    AI4ES_SPLIT: '1',
    AI4ES_API_URL: process.env.AI4ES_API_URL || 'http://127.0.0.1:4000'
  },
  stdio: 'inherit',
  windowsHide: true
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
