import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractBalancedJson, resolvePython } from './compute-sidecar';

function projectPath(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function resolveEsoptEnv() {
  const root = projectPath(process.env.ESOPT_ROOT?.trim() || path.join('tools', 'esopt'));
  const bridge = projectPath(
    process.env.ESOPT_BRIDGE?.trim() || path.join('tools', 'esopt', 'esopt_bridge')
  );
  const python = resolvePython('ESOPT_PYTHON', path.join(process.cwd(), 'tools', 'esopt-venv'));
  return { root, bridge, python };
}

export type EsoptInstallation = {
  root: string;
  bridge: string;
  python: string;
  bridgeReady: boolean;
  solverReady: boolean;
  highsReady: boolean;
  highspyReady: boolean;
  caseCount: number;
  ready: boolean;
  detail: string;
};

let highspyCache: { at: number; python: string; ok: boolean } | null = null;

function probeHighspy(python: string) {
  const now = Date.now();
  if (highspyCache && highspyCache.python === python && now - highspyCache.at < 60_000) {
    return highspyCache.ok;
  }
  const result = spawnSync(python, ['-c', 'import highspy; print("ok")'], {
    encoding: 'utf8',
    timeout: 12_000,
    windowsHide: true
  });
  const ok = result.status === 0 && /ok/.test(String(result.stdout || ''));
  highspyCache = { at: now, python, ok };
  return ok;
}

/**
 * Check the local ESOPT bundle without starting the MCP process or a solve.
 */
export function inspectEsoptInstallation(): EsoptInstallation {
  const { root, bridge, python } = resolveEsoptEnv();
  const dcopfRoot = [path.join(root, 'work', 'DCOPF'), path.join(root, 'DCOPF')]
    .find((candidate) => fs.existsSync(candidate)) || path.join(root, 'work', 'DCOPF');
  const buildRoot = path.join(dcopfRoot, 'build');
  const nativeSolver = fs.existsSync(path.join(buildRoot, 'esoptc.exe'))
    || fs.existsSync(path.join(buildRoot, 'esoptc'))
    || fs.existsSync(path.join(buildRoot, 'dc_opf.exe'))
    || fs.existsSync(path.join(buildRoot, 'dc_opf'));
  const nativeHighs = fs.existsSync(path.join(buildRoot, 'highs.dll'))
    || fs.existsSync(path.join(buildRoot, 'libhighs.so'))
    || fs.existsSync(path.join(buildRoot, 'libhighs.dylib'));
  const highspyReady = probeHighspy(python);
  const solverReady = nativeSolver || highspyReady;
  const highsReady = nativeHighs || highspyReady;
  const casesRoot = path.join(dcopfRoot, 'cases');
  let caseCount = 0;
  try {
    caseCount = fs.readdirSync(casesRoot).filter((entry) => entry.toLowerCase().endsWith('.json')).length;
  } catch {
    caseCount = 0;
  }
  const bridgeReady = fs.existsSync(path.join(bridge, 'esopt_agent'));
  const ready = bridgeReady && solverReady && highsReady && caseCount > 0;
  const engine = nativeSolver && nativeHighs ? 'HiGHS / esoptc' : highspyReady ? 'highspy' : 'unavailable';
  const detail = ready
    ? `ESOPT MCP ready · ${engine} · ${caseCount} DCOPF cases`
    : !bridgeReady
      ? `MCP bridge unavailable · ${bridge}`
      : !solverReady
        ? `Solver unavailable · ${buildRoot}（无 esoptc，且 highspy 不可用）`
        : !highsReady
          ? `HiGHS runtime unavailable · ${buildRoot}`
          : `No DCOPF cases found · ${casesRoot}`;
  return { root, bridge, python, bridgeReady, solverReady, highsReady, highspyReady, caseCount, ready, detail };
}

function translateEsoptError(message: string) {
  if (/variables array/i.test(message)) {
    return '模型文件缺少 variables 数组。标准算例应写成 {"case":"case24"}，自定义问题需要完整线性模型。';
  }
  if (/must contain an objective/i.test(message)) {
    return '模型文件缺少 objective。';
  }
  if (/Cannot open model JSON/i.test(message)) {
    return '打不开 model.json，请检查文件是否已写入工作区。';
  }
  if (/Unknown case/i.test(message)) {
    return `未知电网算例：${message}`;
  }
  return message;
}

export function isTimedMpsSolve(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  const status = String(record.status || record.termination_status || '');
  const objective = Number(record.objective ?? record.objective_value);
  const mode = String(record.mode || record.modelFile || '');
  return /time_limit/i.test(status)
    && Number.isFinite(objective)
    && (mode === 'mps' || mode === 'lp' || /\.(mps|lp)$/i.test(mode) || String(record.engine || '') === 'esopt');
}

export function hasUsableMpsValues(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  const values = record.values;
  if (values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length > 0) {
    return true;
  }
  const solutionFile = String(record.solutionFile || '').trim();
  return Boolean(solutionFile);
}

export function isOptimalSolve(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (record.fixture === true) return false;
  const status = record.termination_status ?? record.terminationStatus ?? record.status;
  if (status === 'planned' || status === 'fixture' || status === 'sample') return false;
  if (status === 7 || status === '7') return true;
  if (record.ok === true && record.success === true) return true;
  if (record.ok === true && (status === 'success' || status === 'succeeded')) return true;
  if (
    record.ok === true
    && (String(record.engine || '') === 'openTEPES' || String(record.engine || '') === 'tdmg-acopf')
    && /optimal/i.test(String(record.status || ''))
  ) {
    return true;
  }
  if (record.ok === true && /optimal/i.test(String(record.status || ''))) return true;
  return false;
}

function runEsoptCli(args: string[], timeoutMs = 120_000, extraEnv?: Record<string, string>) {
  const { root, bridge, python } = resolveEsoptEnv();
  if (!fs.existsSync(bridge)) {
    throw new Error(`未找到 ESOPT 桥接目录：${bridge}。请设置 ESOPT_ROOT / ESOPT_BRIDGE。`);
  }
  const result = spawnSync(python, ['-u', '-m', 'esopt_agent', ...args], {
    cwd: bridge,
    env: {
      ...process.env,
      PYTHONPATH: bridge,
      ESOPT_ROOT: root,
      ...extraEnv
    },
    encoding: 'utf8',
    timeout: timeoutMs + 90_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    const timedOut = result.error.message.includes('ETIMEDOUT') || /ETIMEDOUT/i.test(String(result.error));
    throw timedOut
      ? new Error(`ESOPT / HiGHS 超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回结果。大模型可继续在本机用更长时限单独求解。`)
      : result.error;
  }
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (!stdout) {
    const signal = result.signal ? ` signal ${result.signal}` : '';
    throw new Error(stderr || `ESOPT CLI 无输出（exit ${result.status}${signal}）。`);
  }
  const start = stdout.indexOf('{');
  const raw = start >= 0 ? (extractBalancedJson(stdout, start) || stdout.slice(start)) : stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(stderr || 'ESOPT CLI 返回的不是 JSON。');
  }
  if (parsed && typeof parsed === 'object' && 'ok' in parsed && (parsed as { ok?: unknown }).ok === false) {
    throw new Error(translateEsoptError(String((parsed as { error?: unknown }).error || 'ESOPT 求解失败。')));
  }
  return parsed;
}

function runEsoptCliAsync(args: string[], timeoutMs = 120_000, extraEnv?: Record<string, string>) {
  const { root, bridge, python } = resolveEsoptEnv();
  if (!fs.existsSync(bridge)) {
    throw new Error(`未找到 ESOPT 桥接目录：${bridge}。请设置 ESOPT_ROOT / ESOPT_BRIDGE。`);
  }
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(python, ['-u', '-m', 'esopt_agent', ...args], {
      cwd: bridge,
      env: {
        ...process.env,
        PYTHONPATH: bridge,
        ESOPT_ROOT: root,
        ...extraEnv
      },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ESOPT / HiGHS 超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回结果。`));
    }, timeoutMs + 90_000);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (!text) {
        reject(new Error(stderr.trim() || `ESOPT CLI 无输出（exit ${code ?? '?'}${signal ? ` signal ${signal}` : ''}）。`));
        return;
      }
      const start = text.indexOf('{');
      const raw = start >= 0 ? (extractBalancedJson(text, start) || text.slice(start)) : text;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && 'ok' in parsed && (parsed as { ok?: unknown }).ok === false) {
          reject(new Error(translateEsoptError(String((parsed as { error?: unknown }).error || 'ESOPT 求解失败。'))));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(stderr.trim() || 'ESOPT CLI 返回的不是 JSON。'));
      }
    });
  });
}

export function getEsoptCapabilities() {
  return runEsoptCli(['capabilities'], 30_000) as Record<string, unknown>;
}

export function listEsoptCases() {
  return runEsoptCli(['cases'], 60_000);
}

export function inspectEsoptCase(caseName: string) {
  return runEsoptCli(['inspect', caseName], 60_000) as Record<string, unknown>;
}

export function compareEsoptReference(caseName: string, objective?: number) {
  const args = ['compare', caseName];
  if (objective != null && Number.isFinite(objective)) args.push('--objective', String(objective));
  return runEsoptCli(args, 30_000) as Record<string, unknown>;
}

export function loadEsoptTemplate(name?: string, solve = false) {
  const args = name ? ['template', name] : ['template'];
  if (name && solve) args.push('--solve');
  return runEsoptCli(args, 60_000);
}

export function isEsoptMathProgPath(filePath: string) {
  return /\.(mps|lp)$/i.test(filePath);
}

export const MPS_SOLVE_TIMEOUT_SEC = 60 * 60;
export const MPS_PROCESS_WATCHDOG_MS = MPS_SOLVE_TIMEOUT_SEC * 1000;

export function solveModelJsonFile(modelPath: string, timeoutMs = 180_000) {
  if (!fs.existsSync(modelPath)) throw new Error(`模型文件不存在：${modelPath}`);
  if (isEsoptMathProgPath(modelPath)) {
    const timeoutSec = Math.max(1, Math.ceil(Math.max(timeoutMs, MPS_PROCESS_WATCHDOG_MS) / 1000));
    return runEsoptCli(
      ['model', modelPath, '--timeout', String(timeoutSec)],
      timeoutSec * 1000
    );
  }
  return runEsoptCli(['model', modelPath], timeoutMs);
}

export function solveMpsFile(modelPath: string, timeoutMs = MPS_PROCESS_WATCHDOG_MS) {
  return solveModelJsonFile(modelPath, timeoutMs);
}

export async function solveMpsFileAsync(modelPath: string, timeoutMs = MPS_PROCESS_WATCHDOG_MS) {
  if (!fs.existsSync(modelPath)) throw new Error(`模型文件不存在：${modelPath}`);
  const timeoutSec = Math.max(1, Math.ceil(Math.max(timeoutMs, MPS_PROCESS_WATCHDOG_MS) / 1000));
  return runEsoptCliAsync(
    ['model', modelPath, '--timeout', String(timeoutSec)],
    timeoutSec * 1000
  );
}

export function solveDcopfCase(caseName: string, options?: {
  pslp?: boolean;
  noPresolve?: boolean;
  noGenerators?: boolean;
  timeout?: number;
}) {
  const timeout = options?.timeout ?? 600;
  const args = ['solve', caseName, '--timeout', String(timeout)];
  if (options?.pslp) args.push('--pslp');
  if (options?.noPresolve) args.push('--no-presolve');
  if (options?.noGenerators) args.push('--no-generators');
  return runEsoptCli(args, (timeout + 20) * 1000);
}

export type IncrementalModelSpec = {
  variables?: Array<{ name?: string; lb?: unknown; ub?: unknown; domain?: string; start?: number }>;
  constraints?: Array<{ name?: string; expr?: string }>;
  objective?: { expr?: string };
};

export function solveIncrementalModel(spec: IncrementalModelSpec, sessionPath: string) {
  const variables = Array.isArray(spec.variables) ? spec.variables : [];
  const constraints = Array.isArray(spec.constraints) ? spec.constraints : [];
  const objective = spec.objective?.expr;
  if (!variables.length || !objective) {
    throw new Error('增量建模需要 variables 与 objective.expr。');
  }
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const env = { ESOPT_SESSION: sessionPath };
  runEsoptCli(['model-new'], 30_000, env);
  for (const variable of variables) {
    if (!variable.name) continue;
    const args = ['add-var', variable.name, '--domain', variable.domain || 'continuous'];
    if (variable.lb != null) args.push('--lb', String(variable.lb));
    if (variable.ub != null) args.push('--ub', String(variable.ub));
    if (variable.start != null) args.push('--start', String(variable.start));
    runEsoptCli(args, 30_000, env);
  }
  for (const constraint of constraints) {
    if (!constraint.expr) continue;
    const args = ['add-con', constraint.expr];
    if (constraint.name) args.push('--name', constraint.name);
    runEsoptCli(args, 30_000, env);
  }
  runEsoptCli(['set-obj', objective], 30_000, env);
  const solved = runEsoptCli(['optimize'], 180_000, env) as Record<string, unknown>;
  try {
    solved.incrementalModel = runEsoptCli(['show-model'], 30_000, env);
  } catch {
    // keep the optimum even if show-model fails
  }
  solved.incremental = true;
  return solved;
}
