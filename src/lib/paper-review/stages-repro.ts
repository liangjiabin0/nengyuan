import fs from 'node:fs';
import type { StageFn } from './stage-kit';
import { P, askJson } from './stage-kit';
import { CATEGORY_REFERENCE, reviewReference, systemPrompt } from './prompts';
import {
  checkEnvironment,
  executeReproduction,
  writeReproScripts,
  writeReproductionRecords,
  type ReproExecution,
  type ReproPlan
} from './reproduction';
import { readJson, writeJsonAtomic } from './workspace';

const REPRO = (ctx: Parameters<StageFn>[0], ...rel: string[]) => P(ctx, 'reproduction', ...rel);

export type ReproVerdict = {
  verdict: 'verified_in_scope' | 'partially_verified' | 'not_supported_in_test' | 'blocked' | 'not_assessable';
  verification_scope: 'reporting_only' | 'artifacts_inspected' | 'partial_execution' | 'end_to_end_execution';
  findings: Array<{ claim_id: string; observation: string; supports: string }>;
  independent_checks: string[];
  limitations: string[];
  chart_candidates: Array<{ id: string; title: string; data_path: string; x: string; y: string[]; data_origin: string; note: string }>;
};

export const stageDatasetDiscovery: StageFn = async (ctx) => {
  const out = P(ctx, 'work', 'dataset.json');
  if (!ctx.task.options.reproduce) {
    writeJsonAtomic(out, { strategy: 'none', reason: '用户关闭了复现' });
    return { outputs: [out], summary: { strategy: 'none' } };
  }
  const evidence = readJson(P(ctx, 'work', 'evidence-map.json'), {});
  const cls = readJson<{ primary_category: string }>(P(ctx, 'work', 'classification.json'), { primary_category: '' });
  const local = ctx.task.inputs.filter((i) => i.role === 'data' || i.role === 'code').map((i) => ({ name: i.name, role: i.role, bytes: i.size }));
  const result = await askJson<Record<string, unknown>>(ctx, 'dataset_discovery', [
    { role: 'system', content: systemPrompt('科学计算复现工程师') },
    {
      role: 'user',
      content: [
        reviewReference('data-availability-reproduction.md'),
        `论文分类：${cls.primary_category}；用户偏好数据来源：${ctx.task.options.dataPriority}`,
        `用户上传的数据/代码：${JSON.stringify(local)}`,
        `证据矩阵：<tool_output>${JSON.stringify(evidence).slice(0, 150_000)}</tool_output>`,
        '按“论文公开数据 → 同领域权威开放数据/IEEE 标准算例 → 与论文关键数学结构与物理约束一致的透明模拟样例”的顺序选择复现数据。',
        '注意：本地复现脚本断网运行，不能在运行时下载数据；若用公开标准算例，只能用脚本内嵌其公开参数，并写明来源；否则使用透明模拟样例。不得编造来源、URL 或许可。',
        '输出 JSON：{"strategy":"public|local_licensed|simulated|none","description":"","sources":[{"name":"","url":"","doi":"","license":"","note":""}],"simulated_design":{"mechanism":"","parameters":{},"units":{},"ranges":{},"differences_from_paper":[""]},"blockers":[""]}'
      ].join('\n\n')
    }
  ]);
  writeJsonAtomic(out, result);
  await ctx.log(`复现数据策略：${String(result.strategy)}`);
  return { outputs: [out], summary: { strategy: result.strategy } };
};

export const stageReproductionDesign: StageFn = async (ctx) => {
  const out = P(ctx, 'work', 'repro-plan.json');
  const dataset = readJson<{ strategy?: string }>(P(ctx, 'work', 'dataset.json'), {});
  if (!ctx.task.options.reproduce || dataset.strategy === 'none') {
    const plan: ReproPlan = {
      mode: 'reporting_only', dataStrategy: 'none', dataDescription: '未执行复现', retainedComponents: [], omittedComponents: [],
      scopeRationale: ctx.task.options.reproduce ? '缺少可用于复现的数据或模型信息' : '用户关闭了复现', assumptions: [],
      pythonPackages: [], scripts: [], runOrder: [], expectedOutputs: [], dataSources: []
    };
    writeJsonAtomic(out, plan);
    return { outputs: [out], summary: { mode: plan.mode } };
  }
  const evidence = readJson(P(ctx, 'work', 'evidence-map.json'), {});
  const cls = readJson<{ primary_category: string }>(P(ctx, 'work', 'classification.json'), { primary_category: '' });
  const ref = CATEGORY_REFERENCE[cls.primary_category];
  const plan = await askJson<ReproPlan>(ctx, 'reproduction_design', [
    { role: 'system', content: systemPrompt('科学计算复现工程师') },
    {
      role: 'user',
      content: [
        ref ? reviewReference(ref) : '',
        reviewReference('power-system-review-memory.md').slice(0, 30_000),
        `论文分类：${cls.primary_category}`,
        `证据矩阵与关键公式：<tool_output>${JSON.stringify(evidence).slice(0, 150_000)}</tool_output>`,
        `数据方案：<tool_output>${JSON.stringify(dataset).slice(0, 40_000)}</tool_output>`,
        `随机种子从环境变量 REPRO_SEED 读取（值为 ${ctx.task.options.seed}）；结果写入 outputs/ 目录，数据写入 data/，图保存到 outputs/figures/。`,
        '可用 Python 包：numpy、scipy、pandas、scikit-learn、matplotlib。没有 highspy/gurobi/cplex；优化问题用 scipy.optimize（linprog / milp / minimize）构建结构等价的缩小算例。',
        '脚本限制：不能联网、不能调用 subprocess/os.system、不能读取环境变量中的密钥、不能访问 ../ 之外的路径；每个脚本应在几分钟内跑完。',
        '必须真正实现论文方法的关键机制（目标、约束、算法步骤或模型结构），至少包含一个合理的基线/对照和一项敏感性或稳健性检查；结果写成机器可读的 CSV/JSON（如 outputs/metrics.json、outputs/series.csv）。',
        '复现不追求与原文数值一致，而是检验机制是否可实现、约束是否正确、趋势与主张是否在有限范围内得到支持。',
        '输出 JSON：{"mode":"principle_level|partial_execution|result_replication","dataStrategy":"public|local_licensed|simulated","dataDescription":"","retainedComponents":[""],"omittedComponents":[""],"scopeRationale":"","assumptions":[""],"pythonPackages":["numpy"],"scripts":[{"name":"run_repro.py","purpose":"","code":"完整 Python 代码"}],"runOrder":["run_repro.py"],"expectedOutputs":["outputs/metrics.json"],"dataSources":[]}'
      ].filter(Boolean).join('\n\n')
    }
  ], 60_000);
  if (!Array.isArray(plan.scripts) || !plan.scripts.length || !Array.isArray(plan.runOrder) || !plan.runOrder.length) {
    throw new Error('复现设计没有给出可运行的脚本。');
  }
  plan.dataSources = Array.isArray(plan.dataSources) ? plan.dataSources : [];
  plan.expectedOutputs = Array.isArray(plan.expectedOutputs) ? plan.expectedOutputs : [];
  plan.pythonPackages = Array.isArray(plan.pythonPackages) ? plan.pythonPackages : [];
  writeJsonAtomic(out, plan);
  await ctx.log(`复现设计：${plan.mode}，${plan.scripts.length} 个脚本，保留 ${plan.retainedComponents?.length || 0} 个组件，省略 ${plan.omittedComponents?.length || 0} 个`);
  return { outputs: [out], summary: { mode: plan.mode, scripts: plan.scripts.length } };
};

export const stageEnvironmentCheck: StageFn = async (ctx) => {
  const plan = readJson<ReproPlan>(P(ctx, 'work', 'repro-plan.json'), {} as ReproPlan);
  fs.rmSync(REPRO(ctx), { recursive: true, force: true });
  fs.mkdirSync(REPRO(ctx), { recursive: true });
  const rejected = writeReproScripts(REPRO(ctx), plan);
  const env = await checkEnvironment(ctx.python, plan, REPRO(ctx));
  const out = P(ctx, 'work', 'environment.json');
  writeJsonAtomic(out, { ...env, rejectedScripts: rejected });
  for (const r of rejected) await ctx.log(`脚本 ${r.name} 未通过安全检查：${r.problems.join('、')}`, 'warn');
  if (env.missingPackages.length) await ctx.log(`本机缺少 Python 包：${env.missingPackages.join('、')}（不会自动安装）`, 'warn');
  await ctx.log(`隔离级别：${env.isolation}`);
  return { outputs: [out], summary: { missingPackages: env.missingPackages, rejected: rejected.length } };
};

export const stageReproductionExecute: StageFn = async (ctx) => {
  const plan = readJson<ReproPlan>(P(ctx, 'work', 'repro-plan.json'), {} as ReproPlan);
  const out = P(ctx, 'work', 'execution.json');
  if (plan.mode === 'reporting_only' || !plan.runOrder?.length) {
    const empty: ReproExecution = { runs: [], outputs: [], missingOutputs: [], environment: {}, allSucceeded: false };
    writeJsonAtomic(out, empty);
    return { outputs: [out], summary: { executed: false } };
  }
  if (ctx.task.inputs.some((i) => i.role === 'code') && !ctx.task.options.allowUntrustedCode) {
    await ctx.log('上传了作者代码，但未授权执行不可信代码；本次只运行审稿人自建的复现脚本，不运行作者代码。', 'warn');
  }
  const run = (p: ReproPlan) => executeReproduction(REPRO(ctx), p, {
    python: ctx.python,
    timeoutMs: ctx.task.options.reproductionTimeoutMinutes * 60_000,
    seed: ctx.task.options.seed,
    signal: ctx.signal,
    offline: true,
    onRun: (r) => void ctx.log(`运行 ${r.script}：退出码 ${r.exitCode}${r.timedOut ? '（超时）' : ''}，用时 ${(r.durationMs / 1000).toFixed(1)}s`, r.exitCode === 0 ? 'info' : 'warn', { stderr: r.stderrTail.slice(-800) })
  });
  const exec = await run(plan);
  writeJsonAtomic(out, exec);
  const failed = exec.runs.find((r) => r.exitCode !== 0 && !r.timedOut && r.command);
  if (exec.allSucceeded || !failed) {
    await ctx.log(exec.allSucceeded ? `复现脚本全部运行成功，产出 ${exec.outputs.length} 个文件` : '复现未全部成功', exec.allSucceeded ? 'success' : 'warn');
    return { outputs: [out], summary: { executed: true, allSucceeded: exec.allSucceeded } };
  }
  // 只修复一次：把真实报错交给模型修改脚本，再跑一次；仍失败如实记录，不无限重试。
  await ctx.log(`脚本 ${failed.script} 运行失败，按真实报错修复一次后重跑`, 'warn');
  const fix = await askJson<{ scripts: ReproPlan['scripts'] }>(ctx, 'reproduction_execute', [
    { role: 'system', content: systemPrompt('科学计算复现工程师') },
    {
      role: 'user',
      content: `复现脚本运行失败，下面是真实的运行记录：\n<tool_output>${JSON.stringify({ script: failed.script, exitCode: failed.exitCode, stderr: failed.stderrTail, stdout: failed.stdoutTail.slice(-1500) })}</tool_output>\n原脚本：\n<tool_output>${JSON.stringify(plan.scripts.find((s) => s.name === failed.script))}</tool_output>\n修复错误，但不要改变复现的科学内容，也不要用伪造输出绕过错误。输出 JSON：{"scripts":[{"name":"","purpose":"","code":""}]}`
    }
  ], 40_000);
  const fixed: ReproPlan = { ...plan, scripts: plan.scripts.map((s) => fix.scripts?.find((f) => f.name === s.name) || s) };
  writeJsonAtomic(P(ctx, 'work', 'repro-plan.json'), fixed);
  writeReproScripts(REPRO(ctx), fixed);
  const retry = await run(fixed);
  writeJsonAtomic(out, { ...retry, firstAttempt: { runs: exec.runs } });
  await ctx.log(retry.allSucceeded ? '修复后复现脚本全部运行成功' : '修复后仍未全部成功，将如实记录为部分复现或阻碍', retry.allSucceeded ? 'success' : 'warn');
  return { outputs: [out], summary: { executed: true, allSucceeded: retry.allSucceeded, repaired: true } };
};

export const stageReproductionVerify: StageFn = async (ctx) => {
  const plan = readJson<ReproPlan>(P(ctx, 'work', 'repro-plan.json'), {} as ReproPlan);
  const exec = readJson<ReproExecution>(P(ctx, 'work', 'execution.json'), { runs: [], outputs: [], missingOutputs: [], environment: {}, allSucceeded: false });
  const env = readJson<Record<string, unknown>>(P(ctx, 'work', 'environment.json'), {});
  const evidence = readJson<{ claims?: unknown }>(P(ctx, 'work', 'evidence-map.json'), {});
  const results: Record<string, string> = {};
  for (const o of exec.outputs.filter((x) => /\.(json|csv|txt)$/i.test(x.path) && !x.path.includes('/logs/')).slice(0, 12)) {
    results[o.path] = fs.readFileSync(REPRO(ctx, o.path), 'utf8').slice(0, 12_000);
  }
  const verdict: ReproVerdict = exec.runs.length
    ? await askJson<ReproVerdict>(ctx, 'reproduction_verify', [
        { role: 'system', content: systemPrompt('科学计算复现工程师') },
        {
          role: 'user',
          content: [
            '下面是本地工具真实执行复现脚本的记录与产出（这是唯一可信的执行证据）：',
            `<tool_output>${JSON.stringify({ runs: exec.runs.map((r) => ({ ...r, stdoutTail: r.stdoutTail.slice(-2000), stderrTail: r.stderrTail.slice(-1500) })), missingOutputs: exec.missingOutputs, allSucceeded: exec.allSucceeded, outputs: exec.outputs, results })}</tool_output>`,
            `复现计划：<tool_output>${JSON.stringify({ ...plan, scripts: plan.scripts?.map((s) => ({ name: s.name, purpose: s.purpose })) })}</tool_output>`,
            `论文主张：<tool_output>${JSON.stringify(evidence.claims || []).slice(0, 60_000)}</tool_output>`,
            '判断复现结论：verified_in_scope / partially_verified / not_supported_in_test / blocked / not_assessable。模拟或缩小算例只能支持有限命题；结果与论文矛盾时，先列出审稿人实现、假设和数据替代可能造成的差异，不得据此断言论文造假。',
            'independent_checks：对关键物理量或指标做的独立核算（例如功率平衡残差、约束违反量、与 CSV 的一致性），只写真正能从上述输出核对的内容。',
            'chart_candidates 只能引用 outputs/ 下真实存在的 CSV 文件及其真实列名；data_origin 用 principle_reproduction / simulated_reproduction / partial_reproduction / reproduction_barrier。',
            '输出 JSON：{"verdict":"","verification_scope":"partial_execution|end_to_end_execution|artifacts_inspected|reporting_only","findings":[{"claim_id":"C1","observation":"","supports":"yes|partially|no|not_assessable"}],"independent_checks":[""],"limitations":[""],"chart_candidates":[{"id":"chart-1","title":"","data_path":"outputs/xxx.csv","x":"列名","y":["列名"],"data_origin":"","note":""}]}'
          ].join('\n\n')
        }
      ], 30_000)
    : { verdict: 'not_assessable', verification_scope: 'reporting_only', findings: [], independent_checks: [], limitations: [plan.scopeRationale || '未执行复现'], chart_candidates: [] };
  // 硬约束：没有全部成功执行，不能是 verified_in_scope；没有执行，范围只能是 reporting_only。
  if (!exec.allSucceeded && verdict.verdict === 'verified_in_scope') verdict.verdict = exec.runs.length ? 'partially_verified' : 'not_assessable';
  if (!exec.runs.length) verdict.verification_scope = 'reporting_only';
  if (exec.runs.length && verdict.verification_scope === 'reporting_only') verdict.verification_scope = 'partial_execution';
  verdict.chart_candidates = (verdict.chart_candidates || []).filter((c) => /\.csv$/i.test(c.data_path) && exec.outputs.some((o) => o.path === c.data_path));
  if (plan.runOrder?.length) writeReproductionRecords(REPRO(ctx), plan, env, exec, verdict);
  const out = P(ctx, 'work', 'repro-verdict.json');
  writeJsonAtomic(out, verdict);
  await ctx.log(`复现结论：${verdict.verdict}（${verdict.verification_scope}），可用于 PPT 的真实数据 ${verdict.chart_candidates.length} 组`);
  return { outputs: [out], summary: { verdict: verdict.verdict, charts: verdict.chart_candidates.length } };
};
