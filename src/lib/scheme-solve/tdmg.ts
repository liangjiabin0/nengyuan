import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { trackChildProcess } from '@/lib/runtime-children';
import { parseJsonPayload as parseSidecarJson, resolvePython } from './compute-sidecar';

const TDMG_CHILD = {
  id: 'tdmg',
  name: 'TDMG AC-OPF Sidecar',
  kind: 'sidecar' as const,
  caption: 'Solves AC-OPF dispatch models',
  jobType: 'tdmg-solve'
};

export const TDMG_ENGINE = 'tdmg-acopf';
export const TDMG_DEFAULT_CASE = 'case9';

export const TDMG_BUILTIN_CASES: Record<string, string> = {
  case9: 'case9.py',
  '9': 'case9.py',
  case14: 'case14.py',
  '14': 'case14.py',
  case24: 'case24_ieee_rts.py',
  case24_ieee_rts: 'case24_ieee_rts.py',
  '24': 'case24_ieee_rts.py',
  case30: 'case30.py',
  '30': 'case30.py',
  case39: 'case39.py',
  '39': 'case39.py',
  case57: 'case57.py',
  '57': 'case57.py',
  case118: 'case118.py',
  '118': 'case118.py',
  case300: 'case300.py',
  '300': 'case300.py'
};

export type TdmgHealth = {
  ok: boolean;
  python?: string;
  engine?: boolean;
  vendor?: boolean;
  root?: string;
  error?: string;
};

export type TdmgSidecarResult = {
  ok?: boolean;
  success?: boolean;
  error?: string;
  engine?: string;
  case?: string;
  status?: string;
  objective?: number;
  output?: string;
  periods?: unknown[];
  [key: string]: unknown;
};

export function resolveTdmgRoot() {
  const envRoot = process.env.TDMG_ROOT?.trim();
  if (envRoot) return path.isAbsolute(envRoot) ? envRoot : path.resolve(process.cwd(), envRoot);
  return path.join(process.cwd(), 'tools', 'tdmg-acopf-dispatch');
}

export function resolveTdmgScriptsDir() {
  return path.join(resolveTdmgRoot(), 'scripts');
}

export function resolveTdmgVendorDir() {
  return path.join(resolveTdmgScriptsDir(), '_vendor');
}

export function resolveTdmgPython() {
  if (process.env.TDMG_PYTHON?.trim()) {
    return resolvePython('TDMG_PYTHON', path.join(process.cwd(), 'tools', 'tdmg-venv'));
  }
  if (process.env.MGPLAN_PYTHON?.trim()) {
    return resolvePython('MGPLAN_PYTHON', path.join(process.cwd(), 'tools', 'tdmg-venv'));
  }
  return resolvePython('TDMG_PYTHON', path.join(process.cwd(), 'tools', 'tdmg-venv'));
}

export function resolveTdmgPypowerDir() {
  const vendored = path.join(resolveTdmgVendorDir(), 'pypower');
  if (fs.existsSync(vendored)) return vendored;
  const python = resolveTdmgPython();
  const venvSitePackages = path.join(path.dirname(path.dirname(python)), 'Lib', 'site-packages', 'pypower');
  return fs.existsSync(venvSitePackages) ? venvSitePackages : vendored;
}

export function resolveBuiltinCaseFile(caseName: string) {
  const key = String(caseName || '').trim().toLowerCase().replace(/^pglib_opf_/, '');
  const fileName = TDMG_BUILTIN_CASES[key];
  if (!fileName) return null;
  const filePath = path.join(resolveTdmgPypowerDir(), fileName);
  return fs.existsSync(filePath) ? filePath : null;
}

function scriptEnv() {
  const scripts = resolveTdmgScriptsDir();
  const vendor = resolveTdmgVendorDir();
  return {
    ...process.env,
    PYTHONPATH: `${vendor}${path.delimiter}${scripts}${path.delimiter}${process.env.PYTHONPATH || ''}`,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    TDMG_ROOT: resolveTdmgRoot()
  };
}

function parseJsonPayload(text: string) {
  return parseSidecarJson(text) as TdmgSidecarResult | null;
}

function absPath(filePath: string) {
  return path.resolve(filePath);
}

function assertToolRoot() {
  const root = resolveTdmgRoot();
  const script = path.join(resolveTdmgScriptsDir(), 'tdmg_opf.py');
  if (!fs.existsSync(script)) {
    throw new Error(`未找到 TDMG AC-OPF 脚本：${script}。请设置 TDMG_ROOT。`);
  }
  return root;
}

export function runTdmgScriptSync(
  script: 'tdmg_opf.py' | 'modular_dispatch.py' | 'resource_models.py' | 'task_pipeline.py',
  args: string[],
  options?: { timeoutMs?: number }
) {
  assertToolRoot();
  const python = resolveTdmgPython();
  const scriptPath = path.join(resolveTdmgScriptsDir(), script);
  const result = spawnSync(python, ['-u', scriptPath, ...args], {
    cwd: resolveTdmgScriptsDir(),
    env: scriptEnv(),
    encoding: 'utf8',
    timeout: options?.timeoutMs ?? 60_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.status !== 0 && result.status !== 3) {
    throw new Error(stderr.trim() || stdout.trim() || `TDMG 侧车失败（exit ${result.status}）。`);
  }
  return { stdout, stderr, status: result.status ?? 1 };
}

export function runTdmgScript(
  script: 'tdmg_opf.py' | 'modular_dispatch.py',
  args: string[],
  options?: { timeoutMs?: number }
) {
  assertToolRoot();
  const python = resolveTdmgPython();
  const scriptPath = path.join(resolveTdmgScriptsDir(), script);
  return new Promise<{ stdout: string; stderr: string; status: number }>((resolve, reject) => {
    const child = spawn(python, ['-u', scriptPath, ...args], {
      cwd: resolveTdmgScriptsDir(),
      env: scriptEnv(),
      windowsHide: true
    });
    trackChildProcess(child, TDMG_CHILD);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error('TDMG AC-OPF 求解超时。'));
      }
    }, options?.timeoutMs ?? 15 * 60 * 1000);

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
      resolve({ stdout, stderr, status: code ?? 1 });
    });
  });
}

export function getTdmgHealth(): TdmgHealth {
  try {
    assertToolRoot();
    const vendorOk = fs.existsSync(resolveTdmgPypowerDir());
    if (!vendorOk) {
      return {
        ok: false,
        python: resolveTdmgPython(),
        vendor: false,
        engine: false,
        root: resolveTdmgRoot(),
        error: '未找到 PYPOWER。请运行 npm run portable:install 创建项目内 tools/tdmg-venv。'
      };
    }
    const result = runTdmgScriptSync('modular_dispatch.py', ['catalog'], { timeoutMs: 20_000 });
    const parsed = parseJsonPayload(result.stdout);
    const engine = Boolean(parsed && parsed.modules);
    return {
      ok: engine,
      python: resolveTdmgPython(),
      engine,
      vendor: true,
      root: resolveTdmgRoot(),
      error: engine ? undefined : (result.stderr.trim() || 'TDMG 目录探测失败。')
    };
  } catch (error) {
    return {
      ok: false,
      python: resolveTdmgPython(),
      root: resolveTdmgRoot(),
      vendor: fs.existsSync(resolveTdmgPypowerDir()),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runTdmgSolve(casePath: string, outputDir: string, options?: {
  sidecarPath?: string;
  profilesPath?: string;
  timeoutMs?: number;
}) {
  const args = ['solve', absPath(casePath), '--output', absPath(outputDir)];
  if (options?.sidecarPath) args.push('--config', absPath(options.sidecarPath));
  if (options?.profilesPath) args.push('--profiles', absPath(options.profilesPath));
  const result = await runTdmgScript('tdmg_opf.py', args, { timeoutMs: options?.timeoutMs });
  const parsed = parseJsonPayload(result.stdout);
  if (!parsed) {
    throw new Error(result.stderr.trim() || `TDMG 求解无 JSON 输出（exit ${result.status}）。`);
  }
  if (parsed.success === false || result.status === 3) {
    throw new Error(String(parsed.error || 'TDMG AC-OPF 未收敛。'));
  }
  return parsed;
}

export async function runTdmgModular(scenarioPath: string, outputDir: string, options?: { timeoutMs?: number }) {
  const result = await runTdmgScript('modular_dispatch.py', ['run', absPath(scenarioPath), '--output', absPath(outputDir)], {
    timeoutMs: options?.timeoutMs
  });
  const parsed = parseJsonPayload(result.stdout);
  if (!parsed) {
    throw new Error(result.stderr.trim() || `TDMG 模块化调度无 JSON 输出（exit ${result.status}）。`);
  }
  return parsed;
}

export function inspectTdmgCase(casePath: string, sidecarPath: string) {
  const result = runTdmgScriptSync('tdmg_opf.py', ['inspect', absPath(casePath), '--output', absPath(sidecarPath)], { timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'TDMG inspect 失败。');
  }
  return sidecarPath;
}

export function prepareTdmgTaskPackage(input: {
  casePath: string;
  outputDir: string;
  request: string;
  mode?: 'auto' | 'snapshot' | 'scenario';
  sidecarPath?: string;
  profilesPath?: string;
  dc?: boolean;
}) {
  const args = [
    'prepare',
    absPath(input.casePath),
    '--output',
    absPath(input.outputDir),
    '--request',
    input.request || '交流最优潮流',
    '--mode',
    input.mode || 'auto',
    '--force'
  ];
  if (input.mode !== 'scenario') {
    if (input.sidecarPath) args.push('--sidecar', absPath(input.sidecarPath));
    if (input.profilesPath) args.push('--profiles', absPath(input.profilesPath));
    if (input.dc) args.push('--dc');
  }
  const result = runTdmgScriptSync('task_pipeline.py', args, { timeoutMs: 60_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'TDMG task_pipeline prepare 失败。');
  }
  return input.outputDir;
}

export function runTdmgGeneratedDispatch(taskDir: string, options?: { timeoutMs?: number }) {
  const program = path.join(absPath(taskDir), 'generated_dispatch.py');
  if (!fs.existsSync(program)) {
    throw new Error(`未找到任务程序：${program}`);
  }
  const python = resolveTdmgPython();
  return new Promise<{ stdout: string; stderr: string; status: number }>((resolve, reject) => {
    const child = spawn(python, ['-u', program], {
      cwd: path.dirname(program),
      env: scriptEnv(),
      windowsHide: true
    });
    trackChildProcess(child, TDMG_CHILD);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error('TDMG generated_dispatch.py 求解超时。'));
      }
    }, options?.timeoutMs ?? 15 * 60 * 1000);

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
      resolve({ stdout, stderr, status: code ?? 1 });
    });
  });
}

export function writeTdmgScenarioTemplate(casePath: string, scenarioPath: string, sidecarPath?: string) {
  const args = ['template', absPath(casePath), '--output', absPath(scenarioPath)];
  if (sidecarPath) args.push('--sidecar', absPath(sidecarPath));
  const result = runTdmgScriptSync('modular_dispatch.py', args, { timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'TDMG scenario 模板生成失败。');
  }
  return scenarioPath;
}
