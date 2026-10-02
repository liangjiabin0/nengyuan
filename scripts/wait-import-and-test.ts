import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const statePath = path.join(process.cwd(), 'storage', 'import-job.json');
const pollMs = 30_000;
const maxWaitMs = 4 * 60 * 60 * 1000;

function readState() {
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      status: string;
      phase: string;
      message: string;
      error?: string;
    };
  } catch {
    return null;
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForImport() {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const state = readState();
    if (!state) {
      console.log('[wait] 未发现 import-job.json，假定导入未启动');
      return true;
    }
    console.log(`[wait] status=${state.status} phase=${state.phase} message=${state.message}`);
    if (state.status === 'done') return true;
    if (state.status === 'error') {
      console.error('[wait] 导入失败:', state.error || state.message);
      return false;
    }
    if (state.status === 'idle') return true;
    await sleep(pollMs);
  }
  console.error('[wait] 等待导入超时');
  return false;
}

function runTest() {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/test-20-questions.ts'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: true
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  console.log('[wait-import-and-test] 等待导入与索引重建完成...');
  const ready = await waitForImport();
  if (!ready) process.exit(1);
  console.log('[wait-import-and-test] 开始 20 题测试');
  const code = await runTest();
  process.exit(code);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
