import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Preparation step failed (exit ${result.status}).`);
}

try {
  if (process.platform !== 'win32') throw new Error('This local launcher requires Windows.');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsx)) throw new Error('Run npm ci before npm run prepare:local.');

  const envPath = path.join(root, '.env.local');
  if (!fs.existsSync(envPath)) {
    const candidates = [path.join(root, '数据'), path.resolve(root, '..', '..', '数据')];
    const dataRoot = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
    const password = crypto.randomBytes(18).toString('base64url');
    const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const env = template
      .replace(/^DEFAULT_ADMIN_PASSWORD=.*$/m, `DEFAULT_ADMIN_PASSWORD=${password}`)
      .replace(/^DATA_ROOT_DIR=.*$/m, `DATA_ROOT_DIR="${dataRoot.replaceAll('\\', '/')}"`);
    fs.writeFileSync(envPath, env, { encoding: 'utf8', flag: 'wx' });
    console.log('Created .env.local. Admin username: admin; password: DEFAULT_ADMIN_PASSWORD in that file.');
  } else {
    console.log('Keeping existing .env.local and administrator credentials.');
  }

  for (const dir of ['storage', '.opencode/agents', '.opencode/skills']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  console.log('Agent/skill directories are ready; original custom agent files must be restored separately.');
  run(process.execPath, [tsx, path.join(root, 'scripts', 'export-knowledge-corpus.ts')]);
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'opencode-sidecar.ps1'), 'install']);
  console.log('Local preparation complete. Start with: npm run start:local');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
