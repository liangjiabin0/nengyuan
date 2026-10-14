import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackChildProcess } from '../runtime-children';

/**
 * 受控子进程：用于运行 v8/v3 技能自带脚本和复现脚本。
 * - 工作目录固定在任务目录内；
 * - 环境变量白名单：不继承密钥（API Key、数据库密码、令牌等）；
 * - 超时、取消（AbortSignal）时结束整棵进程树；
 * - stdout/stderr 截断保存，返回退出码和耗时。
 * 注意：这不是容器级隔离（本机没有 Docker/WSL），不可信代码仍能读写当前用户可访问的文件，
 * 因此作者代码必须经用户明确同意才执行（见 runner 中的 allowUntrustedCode）。
 */
export type ProcessResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
};

const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LC_ALL', 'TZ', 'PYTHONHOME'
];

export function sandboxEnv(extra: Record<string, string> = {}, opts: { offline?: boolean } = {}) {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) if (process.env[key] !== undefined) env[key] = String(process.env[key]);
  Object.assign(env, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    MPLBACKEND: 'Agg',
    OMP_NUM_THREADS: process.env.PAPER_REVIEW_THREADS || '4',
    OPENBLAS_NUM_THREADS: process.env.PAPER_REVIEW_THREADS || '4',
    MKL_NUM_THREADS: process.env.PAPER_REVIEW_THREADS || '4'
  });
  if (opts.offline) {
    // 尽力而为的断网：让常见 HTTP 客户端走一个不存在的代理。不能阻止原始 socket。
    Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' });
  }
  return { ...env, ...extra };
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // 进程已经退出
  }
}

const MAX_CAPTURE = 2 * 1024 * 1024;

export async function runControlled(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    logFile?: string;
    stdin?: string;
    tag?: string;
  }
): Promise<ProcessResult> {
  fs.mkdirSync(opts.cwd, { recursive: true });
  const started = Date.now();
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: (opts.env || sandboxEnv()) as NodeJS.ProcessEnv,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    try {
      trackChildProcess(child, {
        id: 'paper-review',
        name: 'Paper Review',
        kind: 'sidecar',
        caption: opts.tag || path.basename(command)
      });
    } catch {
      // 监控登记失败不影响执行
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const log = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: 'a' }) : null;
    log?.write(`$ ${command} ${args.join(' ')}\n# cwd ${opts.cwd}\n# ${new Date().toISOString()}\n`);
    const take = (chunk: Buffer, which: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      log?.write(text);
      if (which === 'out') stdout = (stdout + text).slice(-MAX_CAPTURE);
      else stderr = (stderr + text).slice(-MAX_CAPTURE);
    };
    child.stdout.on('data', (c: Buffer) => take(c, 'out'));
    child.stderr.on('data', (c: Buffer) => take(c, 'err'));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, Math.max(1_000, opts.timeoutMs));
    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      log?.end();
      reject(error);
    });
    child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      log?.end(`\n# exit ${code} signal ${sig} ${Date.now() - started}ms\n`);
      resolve({ command, args, cwd: opts.cwd, exitCode: code, signal: sig, timedOut, cancelled, durationMs: Date.now() - started, stdout, stderr });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export function machineInfo() {
  return { platform: process.platform, arch: process.arch, cpus: os.cpus().length, memGb: Math.round(os.totalmem() / 1e9), node: process.version };
}
