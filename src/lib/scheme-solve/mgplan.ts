import { spawn, spawnSync } from 'node:child_process';
import { childMetaForModule, trackChildProcess } from '@/lib/runtime-children';
import fs from 'node:fs';
import path from 'node:path';

export const MGPLAN_CASE = 'sSEP';
export const MGPLAN_ENGINE = 'openTEPES';

export type MgplanHealth = {
  ok: boolean;
  python?: string;
  engine?: boolean;
  gurobi?: boolean;
  gurobiFullLicense?: boolean;
  gurobiLicense?: string;
  root?: string;
  error?: string;
};

export type MgplanSidecarResult = {
  ok?: boolean;
  type?: string;
  error?: string;
  engine?: string;
  case?: string;
  status?: string;
  objective?: number;
  elapsedSeconds?: number;
  fixture?: boolean;
  costSummary?: Array<Record<string, string>>;
  investment?: Array<Record<string, string>>;
  evaluations?: Array<Record<string, string>>;
  evaluationsEco?: Array<Record<string, string>>;
  outputFiles?: string[];
  outputDir?: string;
  [key: string]: unknown;
};

export function resolveMgplanRoot() {
  const envRoot = process.env.MGPLAN_ROOT?.trim();
  if (envRoot) return envRoot;
  return path.join(process.cwd(), 'tools', 'mgplan');
}

export function resolveMgplanPython() {
  const workspaceVenv = path.join(process.cwd(), 'tools', 'mgplan-venv', 'Scripts', 'python.exe');
  const localPython = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe')
    : undefined;
  const candidates = [
    process.env.MGPLAN_PYTHON?.trim(),
    workspaceVenv,
    localPython,
    'python'
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => candidate === 'python' || fs.existsSync(candidate)) || 'python';
}

function agentEnv(extra?: Record<string, string | undefined>) {
  const root = resolveMgplanRoot();
  return {
    ...process.env,
    PYTHONPATH: `${path.join(root, 'mgplan_agent')}${path.delimiter}${path.join(root, 'scripts')}${path.delimiter}${root}`,
    PYTHONIOENCODING: 'utf-8',
    MPLBACKEND: 'Agg',
    MGPLAN_ROOT: root,
    ...extra
  };
}

function parseJsonPayload(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as MgplanSidecarResult;
    } catch {
      // keep looking
    }
  }
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1)) as MgplanSidecarResult;
  }
  return null;
}

function sanitizeSidecarError(message: string) {
  if (/WLSACCESSID|WLSSECRET|GRB_LICENSE_FILE|license key/i.test(message)) {
    return 'Gurobi 环境未就绪。请配置本机许可证后设置 MGPLAN_PYTHON。';
  }
  return message;
}

function assertToolRoot() {
  const root = resolveMgplanRoot();
  if (!fs.existsSync(path.join(root, 'mgplan_agent'))) {
    throw new Error(`未找到规划计算侧车：${root}`);
  }
  return root;
}

export function runMgplanAgentSync(
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string | undefined> }
) {
  const root = assertToolRoot();
  const python = resolveMgplanPython();
  const result = spawnSync(python, ['-u', '-m', 'mgplan_agent', ...args], {
    cwd: root,
    env: agentEnv(options?.env),
    encoding: 'utf8',
    timeout: options?.timeoutMs ?? 60_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const parsed = parseJsonPayload(stdout);
  if (!parsed) {
    throw new Error(sanitizeSidecarError(stderr.trim() || `规划侧车无输出（exit ${result.status}）。`));
  }
  if (parsed.ok === false) {
    throw new Error(sanitizeSidecarError(String(parsed.error || '规划侧车执行失败。')));
  }
  return parsed;
}

export function runMgplanAgent(
  args: string[],
  options?: {
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  }
) {
  const root = assertToolRoot();
  const python = resolveMgplanPython();
  return new Promise<MgplanSidecarResult>((resolve, reject) => {
    const child = spawn(python, ['-u', '-m', 'mgplan_agent', ...args], {
      cwd: root,
      env: agentEnv(options?.env),
      windowsHide: true
    });
    trackChildProcess(child, childMetaForModule('mgplan_agent'));
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error('规划计算超时。全时序 8760 重算可能需要更长时间。'));
      }
    }, options?.timeoutMs ?? 60 * 60 * 1000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseJsonPayload(stdout);
      if (!parsed) {
        reject(new Error(sanitizeSidecarError(stderr.trim() || `规划侧车无输出（exit ${code}）。`)));
        return;
      }
      if (parsed.ok === false) {
        reject(new Error(sanitizeSidecarError(String(parsed.error || '规划侧车执行失败。'))));
        return;
      }
      resolve(parsed);
    });
  });
}

export function getMgplanHealth(): MgplanHealth {
  try {
    const result = runMgplanAgentSync(['health'], { timeoutMs: 20_000 });
    const engine = Boolean(result.engine);
    const gurobi = Boolean(result.gurobi);
    const gurobiFullLicense = result.gurobiFullLicense === true;
    const gurobiLicense = typeof result.gurobiLicense === 'string' ? result.gurobiLicense : undefined;
    return {
      ok: Boolean(engine && gurobi && gurobiFullLicense),
      python: typeof result.python === 'string' ? result.python : resolveMgplanPython(),
      engine,
      gurobi,
      gurobiFullLicense,
      gurobiLicense,
      root: typeof result.root === 'string' ? result.root : resolveMgplanRoot(),
      error: engine && gurobi && gurobiFullLicense
        ? undefined
        : !gurobi
          ? 'Gurobi 未安装或无法启动，openTEPES 无法重算。'
          : !gurobiFullLicense
            ? 'Gurobi 当前是受限许可证，无法保证运行完整 sSEP。请配置正式、学术或 WLS 许可证。'
          : 'openTEPES 引擎未就绪，无法做源网荷储规划。'
    };
  } catch (error) {
    return {
      ok: false,
      python: resolveMgplanPython(),
      root: resolveMgplanRoot(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function getMgplanCapabilities() {
  return runMgplanAgentSync(['capabilities'], { timeoutMs: 20_000 });
}

export function validateMgplanConfig(configDir: string) {
  return runMgplanAgentSync(['validate', '--config-dir', configDir], { timeoutMs: 30_000 });
}

export function summarizeMgplanOutput(outputDir: string) {
  return runMgplanAgentSync(['summarize', '--output-dir', outputDir], { timeoutMs: 60_000 });
}

export function runMgplanOpenTepes(configDir: string, outputDir: string) {
  return runMgplanAgent(
    ['run', '--config-dir', configDir, '--output-dir', outputDir],
    {
      timeoutMs: 60 * 60 * 1000,
      env: {
        MGPLAN_CONFIG_DIR: configDir,
        MGPLAN_OUTPUT_DIR: outputDir
      }
    }
  );
}
