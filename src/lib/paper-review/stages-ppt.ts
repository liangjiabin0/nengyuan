import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PPT_SKILL_DIR, frozenSkillPath } from './skills';
import { pptReference, pptSkillCore, systemPrompt } from './prompts';
import { runControlled, sandboxEnv } from './process';
import { P, StageBlockedError, askJson, runSkillScript, type Ctx, type StageFn } from './stage-kit';
import type { ReproVerdict } from './stages-repro';
import { reviewJsonPath } from './stages-review';
import { appendUsage } from './store';
import { reviewRenderedSlides } from './visual-review';
import { normalizeResultModules, normalizeSummaryRuns, normalizeV3Plan } from './ppt-normalize';
import { readJson, safeFileName, sha256File, writeFileAtomic, writeJsonAtomic } from './workspace';

const PPT = (ctx: Ctx, ...rel: string[]) => P(ctx, 'ppt', ...rel);
const ROUTE_REF: Record<string, string> = { planning: 'planning-paper.md', forecasting: 'forecasting-paper.md', control: 'control-paper.md' };
const MAX_REPAIR_ROUNDS = 3;

/** 用与构建器相同的离线 MathJax 试渲染 LaTeX；返回错误原因，没问题返回空。 */
async function latexProblem(latex: string) {
  try {
    const mod = (await import(/* webpackIgnore: true */ pathToFileURL(path.join(process.cwd(), 'tools', 'ppt-native', 'math-svg.mjs')).href)) as { renderLatexSvg: (o: { latex: string }) => Promise<string> };
    await mod.renderLatexSvg({ latex });
    return '';
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 160) : String(error);
  }
}

/** 给视觉审核员的设计意图：两页的标题、摘要、机制图节点/连线文字、公式和结果模块，用来核对“图中内容是否与设计一致”。 */
function designSummary(ctx: Ctx, spec: Record<string, unknown>) {
  const s1 = (spec.slide1 || {}) as Record<string, unknown>;
  const graph = readJson<{ nodes?: Array<{ label: string }>; edges?: Array<{ label: string; from: string; to: string }> }>(PPT(ctx, 'semantic-graph.json'), {});
  const text = (runs: unknown) => (Array.isArray(runs) ? runs.map((r) => (r as { text?: string }).text || '').join('') : '');
  return JSON.stringify({
    slide1: {
      title: s1.title,
      summary: text(s1.summaryRuns),
      nodes: (graph.nodes || []).map((n) => n.label),
      edges: (graph.edges || []).map((e) => `${e.from}→${e.to}：${e.label}`),
      formulas: ((s1.formulas as Array<{ id: string; latex: string }>) || []).map((f) => `${f.id}: ${f.latex}`)
    },
    slide2: spec.slide2
  }).slice(0, 9000);
}

/** 写盘前的确定性规范化（规划与每轮修复都要走一遍）。 */
function normalizeAll(plan: { semanticGraph?: unknown; diagramLayout?: unknown }, spec: Record<string, Record<string, unknown>>) {
  const fixes: string[] = [];
  const formulaIds = ((spec.slide1?.formulas as Array<{ id: string }> | undefined) || []).map((f) => f.id);
  if (plan.semanticGraph && plan.diagramLayout) fixes.push(...normalizeV3Plan(plan.semanticGraph as never, plan.diagramLayout as never, formulaIds));
  for (const key of ['slide1', 'slide2'] as const) {
    if (spec[key]) spec[key].summaryRuns = normalizeSummaryRuns(spec[key].summaryRuns as never, fixes, key === 'slide1' ? '第 1 页' : '第 2 页');
  }
  normalizeResultModules(spec.slide2?.resultModules as never, fixes);
  // 单篇评审不生成 contribution-map.json；模型若声明了多贡献文档类型，去掉以免 v3 去找不存在的文件
  if (spec.meta && (spec.meta.contributionMapPath || ['thesis', 'multi-contribution-paper'].includes(String(spec.meta.documentKind)))) {
    delete spec.meta.contributionMapPath;
    delete spec.meta.documentKind;
    fixes.push('去掉未提供的 contribution-map 声明');
  }
  return fixes;
}

/** v3 validate_semantic_graph.py 接受的取值（逐字来自该脚本），明确告诉模型，避免反复撞校验。 */
const V3_ENUMS = [
  'v3 语义图的合法取值（只能用这些，大小写一致）：',
  '- profile：planning | operation | market | control | detection | forecasting',
  '- nodes[].type：input | output | device | bus | plant | controller | optimizer | agent | state | operation | decision | sum | constraint | data',
  '- edges[].kind：power | information | control | feedback | price | response | decision | iteration | data | sequence',
  '- mechanisms[].kind：feedback | branch | coupling | hierarchy | parallel | physical-network | sequence',
  '- diagram-layout.json nodes[].glyph：process | optimizer | controller | decision | sum | bus | battery | converter | solar | load | user | data（不要用 customRenderer）',
  '规则：每个节点都必须至少连一条边；kind=feedback 的机制，其 edgeIds 必须在 nodeIds 内构成有向闭环；kind=branch 必须含一个 type=decision 的节点且它有 ≥2 个不同去向；parallel/physical-network 至少 3 个节点 2 条边；若整张图是一条无分支无环的直链，必须给 linearJustification（reason ≥20 字 + evidenceRef）；formulaLinks 必须恰好覆盖 slide1.formulas 的全部 id。',
  'layout：节点框完全落在 diagramFrame 内；diagramFrame 在 contentFrame 内且面积 ≥ contentFrame 的 45%；每条边 points 的首点在起点节点边框上、末点在终点节点边框上（3px 内），相邻点只能水平或竖直且不重合；labelBox 在 contentFrame 内；fontSize ≥ 14。'
].join('\n');

function finalPptx(ctx: Ctx) {
  const record = readJson<{ metadata?: { paper_title?: string } }>(reviewJsonPath(ctx), {});
  return PPT(ctx, `${safeFileName(String(record.metadata?.paper_title || ctx.task.title))}_Two-Slide_Review.pptx`);
}

/** 把复现输出中真实存在的 CSV 读成图表数据（只取真实数值，不插值、不补点）。 */
function loadChartData(ctx: Ctx, candidates: ReproVerdict['chart_candidates']) {
  const data: Array<Record<string, unknown>> = [];
  for (const c of candidates.slice(0, 4)) {
    const file = P(ctx, 'reproduction', c.data_path);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1, 61).map((l) => l.split(',').map((v) => v.trim().replace(/^"|"$/g, '')));
    data.push({ ...c, header, rows, totalRows: lines.length - 1 });
  }
  return data;
}

/** 规划：生成 v3 标准工件（语义图、布局、方法模型记录、内容 spec、来源索引、证据台账），并跑 v3 校验，失败按真实报错修正。 */
export const stagePptPlan: StageFn = async (ctx) => {
  const record = readJson<Record<string, unknown>>(reviewJsonPath(ctx), {});
  const cls = readJson<{ paper_type_for_ppt: string; primary_category: string; title: string }>(P(ctx, 'work', 'classification.json'), {} as never);
  const evidence = readJson<{ key_equations?: unknown }>(P(ctx, 'work', 'evidence-map.json'), {});
  const verdict = readJson<ReproVerdict>(P(ctx, 'work', 'repro-verdict.json'), { chart_candidates: [] } as unknown as ReproVerdict);
  const route = ctx.task.options.pptTemplate === 'auto' || ctx.task.options.pptTemplate === 'multi_contribution'
    ? cls.paper_type_for_ppt
    : ctx.task.options.pptTemplate === 'forecasting' ? 'forecasting' : ctx.task.options.pptTemplate === 'control' ? 'control' : 'planning';
  const chartData = loadChartData(ctx, verdict.chart_candidates || []);
  fs.mkdirSync(PPT(ctx), { recursive: true });
  const modelRecord = route === 'forecasting' ? 'method-graph.json' : route === 'control' ? 'control-model.md' : 'planning-model.md';
  const W = 1280;
  const H = 720;
  const messages = [
    { role: 'system' as const, content: systemPrompt('学术汇报 PPT 设计师') },
    {
      role: 'user' as const,
      content: [
        '技能规则（two-slide-paper-ppt-codegen v3）：', pptSkillCore(),
        pptReference('graphic-method-workflow.md'), pptReference('two-slide-spec.md'), pptReference(ROUTE_REF[route] || 'planning-paper.md'), pptReference('result-chart-style.md'),
        `评审记录（已冻结，作为唯一事实源）：<tool_output>${JSON.stringify({ metadata: record.metadata, classification: record.classification, conclusion_support: record.conclusion_support, reproduction: record.reproduction, presentation: record.presentation }).slice(0, 60_000)}</tool_output>`,
        `论文关键公式：<tool_output>${JSON.stringify(evidence.key_equations || []).slice(0, 30_000)}</tool_output>`,
        `复现得到的真实数据（第 2 页图表只能用这里的数值，不能插值或编造）：<tool_output>${JSON.stringify(chartData).slice(0, 60_000)}</tool_output>`,
        `复现结论：${verdict.verdict || 'not_assessable'}；局限：${(verdict.limitations || []).join('；')}`,
        V3_ENUMS,
        `画布 ${W}×${H} 像素。页眉（标题+两行摘要）占用 y=0..196，contentFrame.y 必须 ≥ 204；所有节点在 diagramFrame 内；连线点必须落在端点节点边框上（误差 3px 内），且只能是水平或竖直线段；字体 ≥ 14px。公式框位置放在 diagram-layout.json.formulas，且 semantic-graph.json.formulaLinks 恰好覆盖所显示的公式。`,
        '版面硬性要求：每页摘要（summaryRuns 合计）不超过 140 个字符、两句以内；公式最多 4 个，每个公式框紧挨它在 formulaLinks 中关联的节点（距离 ≤ 40px，不要把公式排成远离节点的独立一列），公式框宽 ≥ 260px、高 ≥ 56px；菱形判断节点标签 ≤ 12 个字符；节点标签 ≤ 30 个字符；连线标签框不能与任何节点框重叠。',
        `第 1 页：论文方法/机制图（来自论文的真实物理/信息/决策/反馈关系）+ 关键公式。第 2 页：恰好 3 个 resultModules。优先用审稿人复现的真实数值（标注 data_origin）；论文原文报告值只能作为单独标识的背景参照；没有可靠数值的主题用 metrics 或 table 展示复现阻碍。chart 的 series.values 必须逐个来自上面的真实数据。`,
        '幻灯片可见文字不得出现“来源：”“根据论文”“论文结果”“公式来源”“未运行作者代码”“此处放置”等后台用语，来源写在 evidenceRef 和 notes 里。',
        `输出 JSON：{"semanticGraph":{schemaVersion:1,profile,nodes,edges,mechanisms,formulaLinks},"diagramLayout":{canvas:{width:${W},height:${H}},contentFrame,diagramFrame,fontFamily:"Microsoft YaHei",fontSize,nodes,edges,formulas},"methodModel":${route === 'forecasting' ? '{...方法计算图 JSON}' : '"Markdown 文本：决策主体/目标/约束/求解或控制流程"'},"spec":{meta:{paperTitle,paperType:"${route}",doi,fontFamily:"Microsoft YaHei",slideSize:{width:${W},height:${H}}},slide1:{title,summaryRuns,panels,formulas,notes},slide2:{title,summaryRuns,resultModules,notes}},"sourceIndex":[{"id":"","location":"","description":""}],"evidenceLedger":[{"item":"","value":"","origin":"principle_reproduction|simulated_reproduction|paper_reported_context|reproduction_barrier","source":""}],"visualDesignSpec":"Markdown：模板继承、版式、层次、对象位置、连线和公式布置说明"}`
      ].join('\n\n')
    }
  ];
  let plan = await askJson<Record<string, unknown>>(ctx, 'ppt_plan', messages, 80_000);
  const specPath = PPT(ctx, 'spec.json');
  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const spec = plan.spec as Record<string, Record<string, unknown>>;
    spec.slide1 = { ...spec.slide1, semanticGraphPath: 'semantic-graph.json', diagramLayoutPath: 'diagram-layout.json', [route === 'forecasting' ? 'methodGraphPath' : 'methodModelPath']: modelRecord };
    spec.meta = { ...spec.meta, paperType: route, slideSize: { width: W, height: H }, fontFamily: 'Microsoft YaHei' };
    try {
      const fixes = normalizeAll(plan, spec);
      if (fixes.length) await ctx.log(`本地规范化修正 ${fixes.length} 处结构问题（不改科学内容）：${fixes.slice(0, 6).join('；')}${fixes.length > 6 ? '…' : ''}`);
    } catch (error) {
      await ctx.log(`本地规范化跳过：${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
    writeJsonAtomic(PPT(ctx, 'semantic-graph.json'), plan.semanticGraph);
    writeJsonAtomic(PPT(ctx, 'diagram-layout.json'), plan.diagramLayout);
    if (route === 'forecasting') writeJsonAtomic(PPT(ctx, modelRecord), plan.methodModel);
    else writeFileAtomic(PPT(ctx, modelRecord), String(plan.methodModel || ''));
    writeJsonAtomic(specPath, spec);
    writeJsonAtomic(PPT(ctx, 'source-index.json'), plan.sourceIndex || []);
    writeJsonAtomic(PPT(ctx, 'evidence-ledger.json'), plan.evidenceLedger || []);
    writeFileAtomic(PPT(ctx, 'visual-design-spec.md'), String(plan.visualDesignSpec || ''));
    const checks = [
      await runSkillScript(ctx, PPT_SKILL_DIR, 'validate_semantic_graph.py', [PPT(ctx, 'semantic-graph.json'), '--layout', PPT(ctx, 'diagram-layout.json')]),
      await runSkillScript(ctx, PPT_SKILL_DIR, 'validate_two_slide_spec.py', [specPath]),
      ...(route === 'forecasting' ? [await runSkillScript(ctx, PPT_SKILL_DIR, 'validate_method_graph.py', [PPT(ctx, modelRecord)])] : [])
    ];
    const header = (spec.slide1 && (plan.diagramLayout as { contentFrame?: { y?: number } })?.contentFrame?.y) || 0;
    const errors = checks.filter((c) => !c.ok).map((c) => c.output.slice(0, 1500));
    // 公式先用离线 MathJax 试渲染一遍：有语法错误的公式会让整个 PPT 构建失败，必须在规划阶段就交回模型修正
    for (const f of (spec.slide1.formulas as Array<{ id: string; latex: string }> | undefined) || []) {
      const problem = await latexProblem(f.latex);
      if (problem) errors.push(`公式 ${f.id} 的 LaTeX 无法渲染（${problem}）：${f.latex.slice(0, 200)}`);
    }
    if (header < 204) errors.push(`diagram-layout.json contentFrame.y=${header}，必须 ≥ 204`);
    if (!errors.length) {
      await ctx.log(`PPT 规划通过 v3 校验（第 ${round} 轮）：语义图、两页规格${route === 'forecasting' ? '、方法计算图' : ''}`, 'success');
      return { outputs: ['spec.json', 'semantic-graph.json', 'diagram-layout.json', modelRecord, 'source-index.json', 'evidence-ledger.json', 'visual-design-spec.md'].map((f) => PPT(ctx, f)), summary: { route, rounds: round, charts: chartData.length } };
    }
    await ctx.log(`PPT 规划第 ${round} 轮未通过 v3 校验：${errors.join(' | ').slice(0, 400)}`, 'warn');
    if (round === MAX_REPAIR_ROUNDS) throw new StageBlockedError(`PPT 规划三轮修正后仍未通过 v3 校验：${errors.join(' | ').slice(0, 800)}`);
    plan = await askJson<Record<string, unknown>>(ctx, 'ppt_plan', [
      ...messages,
      { role: 'assistant', content: JSON.stringify(plan).slice(0, 100_000) },
      { role: 'user', content: `v3 校验报错如下，请只修正这些问题（坐标、连线端点、缺失字段、取值、可见文字用语等），科学内容保持不变。修正时不要引入新的问题：逐条对照下面的合法取值和规则自查后，输出完整 JSON。\n${V3_ENUMS}\n<tool_output>${errors.join('\n').slice(0, 5000)}</tool_output>` }
    ], 80_000);
  }
  throw new Error('unreachable');
};

export const stagePptBuild: StageFn = async (ctx) => {
  const out = finalPptx(ctx);
  const builder = path.join(process.cwd(), 'tools', 'ppt-native', 'v3-adapter', 'build-review-deck.mjs');
  const r = await runControlled(process.execPath, [builder, '--spec', PPT(ctx, 'spec.json'), '--out', out, '--skill', frozenSkillPath(ctx.root, PPT_SKILL_DIR), '--work', PPT(ctx)], {
    cwd: process.cwd(), timeoutMs: 300_000, signal: ctx.signal, env: sandboxEnv(), logFile: P(ctx, 'logs', 'ppt-build.log'), tag: 'ppt-build'
  });
  if (r.exitCode !== 0 || !fs.existsSync(out)) throw new Error(`PPT 构建失败：${r.stderr.slice(-800) || r.stdout.slice(-400)}`);
  const audits = [];
  for (const script of ['audit_visible_pptx.py', 'audit_template_bindings.py', 'audit_plot_axes.py']) {
    const a = await runSkillScript(ctx, PPT_SKILL_DIR, script, [out]);
    audits.push({ script, ok: a.ok, output: a.output.slice(-1500) });
  }
  writeJsonAtomic(PPT(ctx, 'build-audits.json'), audits);
  const failed = audits.filter((a) => !a.ok);
  if (failed.length) throw new StageBlockedError(`PPT 未通过 v3 结构审计：${failed.map((f) => `${f.script}：${f.output.slice(0, 300)}`).join('；')}`);
  await ctx.log('两页可编辑 PPT 已生成，并通过 v3 可见文字 / 模板绑定 / 坐标轴审计', 'success');
  return { outputs: [out, PPT(ctx, 'diagram-coverage.json'), PPT(ctx, 'formula-manifest.json'), PPT(ctx, 'build-receipt.json'), PPT(ctx, 'build-audits.json')], summary: { pptx: path.basename(out) } };
};

async function renderFinal(ctx: Ctx, pptx: string) {
  const dir = PPT(ctx, 'render');
  fs.rmSync(dir, { recursive: true, force: true });
  const windows = process.platform === 'win32';
  const script = path.join(process.cwd(), 'scripts', 'paper-review', windows ? 'render-pptx.ps1' : 'render-pptx.py');
  const command = windows ? 'powershell' : ctx.python;
  const args = windows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Pptx', pptx, '-OutDir', dir]
    : [script, '--pptx', pptx, '--out-dir', dir];
  const r = await runControlled(command, args, {
    cwd: process.cwd(), timeoutMs: 300_000, signal: ctx.signal, env: sandboxEnv(), logFile: P(ctx, 'logs', 'ppt-render.log'), tag: 'ppt-render'
  });
  const renders = [path.join(dir, 'slide-01.png'), path.join(dir, 'slide-02.png')];
  if (r.exitCode !== 0 || !renders.every((f) => fs.existsSync(f))) throw new StageBlockedError(`${windows ? 'PowerPoint' : 'LibreOffice / Poppler'} 渲染失败：${(r.stderr || r.stdout).slice(-500)}`);
  if (fs.existsSync(path.join(dir, 'slide-03.png'))) throw new Error('渲染出了第 3 页，PPT 必须恰好两页');
  return renders as [string, string];
}

/** 渲染最终导出的 PPTX → 模型逐页看图审核 → v3 audit_graphic_delivery.py 绑定 hash 校验；不通过就局部修复重建，最多三轮。 */
export const stagePptRenderAudit: StageFn = async (ctx) => {
  const pptx = finalPptx(ctx);
  const spec = readJson<Record<string, unknown>>(PPT(ctx, 'spec.json'), {});
  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const renders = await renderFinal(ctx, pptx);
    const visual = await reviewRenderedSlides({
      endpoint: ctx.endpoint, python: ctx.python, pptx, renders,
      graphPath: PPT(ctx, 'semantic-graph.json'), layoutPath: PPT(ctx, 'diagram-layout.json'), coveragePath: PPT(ctx, 'diagram-coverage.json'),
      specSummary: designSummary(ctx, spec),
      outPath: PPT(ctx, 'visual-review.json'), signal: ctx.signal
    });
    for (const u of visual.usage) await appendUsage(ctx.task.id, u);
    const delivery = await runSkillScript(ctx, PPT_SKILL_DIR, 'audit_graphic_delivery.py', [PPT(ctx, 'spec.json'), pptx, PPT(ctx, 'diagram-coverage.json'), PPT(ctx, 'visual-review.json')]);
    writeJsonAtomic(PPT(ctx, 'delivery-audit.json'), { round, visualPassed: visual.passed, problems: visual.problems, deliveryAudit: { ok: delivery.ok, output: delivery.output.slice(-2000) }, pptxSha256: sha256File(pptx) });
    if (visual.passed && delivery.ok) {
      await ctx.log(`最终渲染审核通过（第 ${round} 轮），审核结果已与最终 PPTX 的 hash 绑定`, 'success');
      return { outputs: [pptx, ...renders, PPT(ctx, 'visual-review.json'), PPT(ctx, 'delivery-audit.json')], summary: { rounds: round, passed: true } };
    }
    await ctx.log(`最终渲染审核第 ${round} 轮未通过：${[...visual.problems, delivery.ok ? '' : delivery.output.slice(0, 200)].filter(Boolean).join('；').slice(0, 500)}`, 'warn');
    if (round === MAX_REPAIR_ROUNDS) {
      throw new StageBlockedError(`PPT 三轮局部修复后仍未通过最终渲染审核，已保留可编辑候选稿（标记为不完整）：${visual.problems.slice(0, 5).join('；')}`);
    }
    // 局部修复：只调整布局坐标、字号、文字长度，不改科学内容。
    const layout = readJson(PPT(ctx, 'diagram-layout.json'), {});
    const fix = await askJson<{ diagramLayout?: unknown; spec?: unknown }>(ctx, 'ppt_render_audit', [
      { role: 'system', content: systemPrompt('学术汇报 PPT 设计师') },
      { role: 'user', content: `最终渲染审核发现以下问题：\n<tool_output>${JSON.stringify(visual.problems)}</tool_output>\n当前布局：<tool_output>${JSON.stringify(layout).slice(0, 40_000)}</tool_output>\n当前 spec：<tool_output>${JSON.stringify(spec).slice(0, 40_000)}</tool_output>\n只做局部修复（坐标、尺寸、字号、文字精简），不得改变科学内容、数值和关系方向；仍要满足 v3 布局约束（连线端点在节点边框上、正交线段、字体 ≥14px、contentFrame.y ≥ 204）。输出 JSON：{"diagramLayout":{...完整布局},"spec":{...完整 spec}}` }
    ], 60_000);
    // 修复结果同样先做确定性规范化（摘要长度、字段名、连线吸附、节点放大），再写盘校验
    const nextSpec = (fix.spec || spec) as Record<string, Record<string, unknown>>;
    const nextLayout = fix.diagramLayout || layout;
    const graphNow = readJson(PPT(ctx, 'semantic-graph.json'), {});
    const repairFixes = normalizeAll({ semanticGraph: graphNow, diagramLayout: nextLayout }, nextSpec);
    if (repairFixes.length) await ctx.log(`修复稿规范化 ${repairFixes.length} 处：${repairFixes.slice(0, 5).join('；')}`);
    writeJsonAtomic(PPT(ctx, 'diagram-layout.json'), nextLayout);
    writeJsonAtomic(PPT(ctx, 'spec.json'), nextSpec);
    const valid = await runSkillScript(ctx, PPT_SKILL_DIR, 'validate_two_slide_spec.py', [PPT(ctx, 'spec.json')]);
    if (!valid.ok) {
      await ctx.log(`修复后的规格未通过 v3 校验，恢复上一版重试：${valid.output.slice(0, 200)}`, 'warn');
      writeJsonAtomic(PPT(ctx, 'diagram-layout.json'), layout);
      writeJsonAtomic(PPT(ctx, 'spec.json'), spec);
    }
    await stagePptBuild(ctx);
  }
  throw new Error('unreachable');
};
