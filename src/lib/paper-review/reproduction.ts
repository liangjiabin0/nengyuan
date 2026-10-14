import fs from 'node:fs';
import path from 'node:path';
import { runControlled, sandboxEnv, machineInfo, type ProcessResult } from './process';
import { sha256File, sha256Text, writeFileAtomic, writeJsonAtomic } from './workspace';

/**
 * 复现执行器。模型只负责“写出”复现计划和脚本（JSON），
 * 脚本的写盘、运行、计时、日志、hash 全部由这里真实完成。模型拿到的只有这些真实记录。
 */
export type ReproScript = {
  /** Reproduction/scripts/ 下的文件名，只允许 [A-Za-z0-9_.-] */
  name: string;
  purpose: string;
  code: string;
};

export type ReproPlan = {
  mode: 'result_replication' | 'principle_level' | 'partial_execution' | 'reporting_only';
  dataStrategy: 'public' | 'local_licensed' | 'simulated' | 'none';
  dataDescription: string;
  retainedComponents: string[];
  omittedComponents: string[];
  scopeRationale: string;
  assumptions: string[];
  /** 依赖的 Python 包（只做检查，不自动安装） */
  pythonPackages: string[];
  scripts: ReproScript[];
  /** 按顺序运行的脚本名 */
  runOrder: string[];
  /** 运行后应产生的 outputs/ 下的文件（用于核验） */
  expectedOutputs: string[];
  /** 公开数据来源（URL/DOI/许可），没有则空 */
  dataSources: Array<{ name: string; url?: string; doi?: string; license?: string; note?: string }>;
};

export type RunRecord = {
  script: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  scriptSha256: string;
  logPath: string;
};

export type ReproExecution = {
  runs: RunRecord[];
  outputs: Array<{ path: string; sha256: string; bytes: number }>;
  missingOutputs: string[];
  environment: Record<string, unknown>;
  allSucceeded: boolean;
};

const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const ALLOWED_EXT = new Set(['.py', '.json', '.csv', '.txt', '.md', '.yaml', '.yml']);

/** 静态拒绝明显越界的代码：读取环境变量里的密钥、访问项目源码目录、启动 shell 命令等。 */
export function screenScript(code: string): string[] {
  const problems: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/os\.environ\[?\s*['"][A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/i, '读取密钥类环境变量'],
    [/\bsubprocess\b|\bos\.system\b|\bos\.popen\b|\bpty\b/, '启动外部命令'],
    [/\.\.[\\/]/, '使用 ../ 访问任务目录之外的路径'],
    [/(^|['"])(\/etc|\/root|C:\\\\Windows|C:\/Windows)/i, '访问系统目录'],
    [/\.env(\.local)?['"]/, '读取 .env 配置文件'],
    [/shutil\.rmtree\(\s*['"]\//, '删除绝对路径目录']
  ];
  for (const [re, label] of rules) if (re.test(code)) problems.push(label);
  return problems;
}

export function writeReproScripts(reproDir: string, plan: ReproPlan) {
  const scriptsDir = path.join(reproDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.join(reproDir, 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(reproDir, 'data'), { recursive: true });
  const rejected: Array<{ name: string; problems: string[] }> = [];
  for (const s of plan.scripts) {
    if (!NAME_RE.test(s.name) || !ALLOWED_EXT.has(path.extname(s.name).toLowerCase())) {
      rejected.push({ name: s.name, problems: ['文件名或扩展名不允许'] });
      continue;
    }
    const problems = path.extname(s.name) === '.py' ? screenScript(s.code) : [];
    if (problems.length) {
      rejected.push({ name: s.name, problems });
      continue;
    }
    writeFileAtomic(path.join(scriptsDir, s.name), s.code);
  }
  return rejected;
}

async function packageVersions(python: string, packages: string[], cwd: string) {
  if (!packages.length) return {};
  const code = [
    'import json, importlib.metadata as m',
    `names=${JSON.stringify(packages)}`,
    'out={}',
    'for n in names:',
    '    try: out[n]=m.version(n)',
    '    except Exception: out[n]=None',
    'print(json.dumps(out))'
  ].join('\n');
  const r = await runControlled(python, ['-c', code], { cwd, timeoutMs: 60_000, env: sandboxEnv() });
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as Record<string, string | null>;
  } catch {
    return {};
  }
}

export async function checkEnvironment(python: string, plan: ReproPlan, cwd: string) {
  const versions = await packageVersions(python, plan.pythonPackages, cwd);
  const pyVersion = await runControlled(python, ['-c', 'import sys;print(sys.version)'], { cwd, timeoutMs: 30_000, env: sandboxEnv() });
  const missing = Object.entries(versions).filter(([, v]) => !v).map(([k]) => k);
  return {
    python,
    pythonVersion: pyVersion.stdout.trim(),
    packages: versions,
    missingPackages: missing,
    machine: machineInfo(),
    isolation: process.platform === 'win32'
      ? '受控子进程（工作目录限定、密钥环境变量剥离、超时与进程树终止）；本机无 Docker/WSL，非容器隔离'
      : '受控子进程（工作目录限定、密钥环境变量剥离、超时与进程组终止）；非容器隔离'
  };
}

export async function executeReproduction(
  reproDir: string,
  plan: ReproPlan,
  opts: { python: string; timeoutMs: number; seed: number; signal?: AbortSignal; offline: boolean; onRun?: (r: RunRecord) => void }
): Promise<ReproExecution> {
  const logsDir = path.join(reproDir, 'outputs', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const runs: RunRecord[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  for (const name of plan.runOrder) {
    if (opts.signal?.aborted) throw new DOMException('任务已取消', 'AbortError');
    const scriptPath = path.join(reproDir, 'scripts', name);
    if (!fs.existsSync(scriptPath)) {
      runs.push({ script: name, command: '', exitCode: null, timedOut: false, cancelled: false, durationMs: 0, stdoutTail: '', stderrTail: '脚本不存在或被安全检查拒绝', scriptSha256: '', logPath: '' });
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 5_000) {
      runs.push({ script: name, command: '', exitCode: null, timedOut: true, cancelled: false, durationMs: 0, stdoutTail: '', stderrTail: '复现总时限已用完', scriptSha256: sha256File(scriptPath), logPath: '' });
      break;
    }
    const logPath = path.join(logsDir, `${name}.log`);
    const result: ProcessResult = await runControlled(opts.python, ['-u', path.join('scripts', name)], {
      cwd: reproDir,
      timeoutMs: remaining,
      signal: opts.signal,
      logFile: logPath,
      tag: `repro:${name}`,
      env: sandboxEnv({ REPRO_SEED: String(opts.seed), PYTHONHASHSEED: String(opts.seed), REPRO_OUTPUT_DIR: 'outputs', REPRO_DATA_DIR: 'data' }, { offline: opts.offline })
    });
    const record: RunRecord = {
      script: name,
      command: `python -u scripts/${name}`,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      stdoutTail: result.stdout.slice(-4000),
      stderrTail: result.stderr.slice(-4000),
      scriptSha256: sha256File(scriptPath),
      logPath: path.relative(reproDir, logPath).split(path.sep).join('/')
    };
    runs.push(record);
    opts.onRun?.(record);
    if (result.cancelled) throw new DOMException('任务已取消', 'AbortError');
    if (result.exitCode !== 0) break;
  }
  const outputsDir = path.join(reproDir, 'outputs');
  const outputs: ReproExecution['outputs'] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else outputs.push({ path: path.relative(reproDir, full).split(path.sep).join('/'), sha256: sha256File(full), bytes: fs.statSync(full).size });
    }
  };
  if (fs.existsSync(outputsDir)) walk(outputsDir);
  const produced = new Set(outputs.map((o) => o.path));
  const missingOutputs = plan.expectedOutputs.filter((p) => !produced.has(p.startsWith('outputs/') ? p : `outputs/${p}`));
  const allSucceeded = runs.length === plan.runOrder.length && runs.every((r) => r.exitCode === 0) && missingOutputs.length === 0;
  return { runs, outputs, missingOutputs, environment: {}, allSucceeded };
}

/** 生成 Reproduction/ 下的交付清单文件。 */
export function writeReproductionRecords(reproDir: string, plan: ReproPlan, env: Record<string, unknown>, exec: ReproExecution, verdict: Record<string, unknown>) {
  writeJsonAtomic(path.join(reproDir, 'config.json'), {
    mode: plan.mode,
    dataStrategy: plan.dataStrategy,
    runOrder: plan.runOrder,
    expectedOutputs: plan.expectedOutputs,
    retainedComponents: plan.retainedComponents,
    omittedComponents: plan.omittedComponents,
    scopeRationale: plan.scopeRationale,
    assumptions: plan.assumptions
  });
  writeJsonAtomic(path.join(reproDir, 'environment.json'), env);
  writeFileAtomic(path.join(reproDir, 'requirements.txt'), `${plan.pythonPackages.map((p) => {
    const v = (env.packages as Record<string, string | null> | undefined)?.[p];
    return v ? `${p}==${v}` : `${p}  # 本机未安装`;
  }).join('\n')}\n`);
  writeJsonAtomic(path.join(reproDir, 'data_manifest.json'), {
    strategy: plan.dataStrategy,
    description: plan.dataDescription,
    sources: plan.dataSources,
    files: exec.outputs.filter((o) => o.path.startsWith('data/'))
  });
  writeJsonAtomic(path.join(reproDir, 'validation.json'), { runs: exec.runs, missingOutputs: exec.missingOutputs, allSucceeded: exec.allSucceeded, ...verdict });
  writeJsonAtomic(path.join(reproDir, 'evidence_manifest.json'), {
    generatedAt: new Date().toISOString(),
    scripts: plan.scripts.map((s) => {
      const p = path.join(reproDir, 'scripts', s.name);
      return { name: s.name, purpose: s.purpose, sha256: fs.existsSync(p) ? sha256File(p) : null };
    }),
    outputs: exec.outputs,
    planSha256: sha256Text(JSON.stringify(plan))
  });
  const lines = [
    '# 原理级复现说明',
    '',
    `- 复现模式：${plan.mode}`,
    `- 数据策略：${plan.dataStrategy} — ${plan.dataDescription}`,
    `- 保留的模型组件：${plan.retainedComponents.join('；') || '无'}`,
    `- 省略的模型组件：${plan.omittedComponents.join('；') || '无'}`,
    `- 范围说明：${plan.scopeRationale}`,
    `- 运行环境：${String(env.pythonVersion || '').split('\n')[0]}；${String(env.isolation || '')}`,
    `- 运行结果：${exec.allSucceeded ? '全部脚本退出码为 0，预期输出均已生成' : '未全部成功，见 validation.json'}`,
    '',
    '## 复跑步骤',
    '',
    '在本目录下依次运行（需 requirements.txt 中的依赖；随机种子通过环境变量 REPRO_SEED 传入）：',
    '',
    ...plan.runOrder.map((n) => `    python -u scripts/${n}`),
    '',
    '## 局限',
    '',
    '模拟或缩小算例只能验证所列的有限命题，不代表原论文真实工况下的性能，也不能证明原论文全部结论成立。',
    ''
  ];
  writeFileAtomic(path.join(reproDir, 'README.md'), lines.join('\n'));
}
