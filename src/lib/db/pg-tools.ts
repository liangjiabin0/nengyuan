import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getDatabaseUrl } from './pg-database';

const BINARIES = ['psql', 'pg_dump', 'pg_restore'] as const;

export function findPostgresBin(name: (typeof BINARIES)[number]): string | null {
  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter);
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  if (fs.existsSync(path.join(programFiles, 'PostgreSQL'))) {
    for (const version of fs.readdirSync(path.join(programFiles, 'PostgreSQL'))) {
      dirs.unshift(path.join(programFiles, 'PostgreSQL', version, 'bin'));
    }
  }
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function parseDatabaseUrl(url = getDatabaseUrl()) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  };
}

export async function runPostgresBin(
  name: (typeof BINARIES)[number],
  args: string[],
  options?: { cwd?: string }
) {
  const bin = findPostgresBin(name);
  if (!bin) {
    throw new Error(`未找到 ${name}。请安装 PostgreSQL 16，并保证 bin 目录在 PATH 或 C:\\Program Files\\PostgreSQL\\16\\bin。`);
  }
  const info = parseDatabaseUrl();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options?.cwd,
      env: { ...process.env, PGPASSWORD: info.password },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} 退出码 ${code}`));
    });
  });
}

export async function dumpDatabase(outFile: string) {
  const info = parseDatabaseUrl();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await runPostgresBin('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--dbname', info.database,
    '--host', info.host,
    '--port', info.port,
    '--username', info.user,
    '--file', outFile
  ]);
}

export async function restoreDatabase(dumpFile: string) {
  const info = parseDatabaseUrl();
  await runPostgresBin('pg_restore', [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    '--dbname', info.database,
    '--host', info.host,
    '--port', info.port,
    '--username', info.user,
    dumpFile
  ]);
}
