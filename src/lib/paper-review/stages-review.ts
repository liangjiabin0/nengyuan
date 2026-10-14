import fs from 'node:fs';
import { REVIEW_SKILL_DIR } from './skills';
import { CATEGORY_REFERENCE, reviewReference, reviewSkillCore, systemPrompt } from './prompts';
import { P, askJson, runSkillScript, type Ctx, type StageFn } from './stage-kit';
import type { ReproVerdict } from './stages-repro';
import type { ReproExecution, ReproPlan } from './reproduction';
import { readJson, safeFileName, writeJsonAtomic } from './workspace';

type ReviewRecord = Record<string, unknown> & {
  metadata: Record<string, unknown>;
  issues?: Array<Record<string, unknown>>;
  presentation?: Record<string, unknown>;
};

export const reviewJsonPath = (ctx: Ctx) => P(ctx, 'review', 'review.json');

function reviewLanguage(ctx: Ctx): 'zh' | 'en' {
  const cls = readJson<{ language?: string }>(P(ctx, 'work', 'classification.json'), {});
  if (ctx.task.options.reportLanguage === 'zh') return 'zh';
  if (ctx.task.options.reportLanguage === 'en_zh') return 'en';
  return cls.language === 'en' ? 'en' : 'zh';
}

/** 生成 canonical review JSON（唯一事实源），并用 v8 validate_review.py 校验；不通过把真实报错交回模型修正，最多 3 轮。 */
export const stageAcademicReview: StageFn = async (ctx) => {
  const cls = readJson<{ primary_category: string; secondary_category: string | null; rationale: string; title: string; paper_type_for_ppt: string }>(P(ctx, 'work', 'classification.json'), {} as never);
  const evidence = readJson(P(ctx, 'work', 'evidence-map.json'), {});
  const plan = readJson<ReproPlan>(P(ctx, 'work', 'repro-plan.json'), {} as ReproPlan);
  const exec = readJson<ReproExecution>(P(ctx, 'work', 'execution.json'), { runs: [], outputs: [], missingOutputs: [], environment: {}, allSucceeded: false });
  const verdict = readJson<ReproVerdict>(P(ctx, 'work', 'repro-verdict.json'), {} as ReproVerdict);
  const map = readJson(P(ctx, 'work', 'paper-map.json'), {});
  const supplements = readJson<unknown[]>(P(ctx, 'work', 'supplements.json'), []);
  const lang = reviewLanguage(ctx);
  const title = cls.title || ctx.task.title;
  const pptxPath = P(ctx, 'ppt', `${safeFileName(title)}_Two-Slide_Review.pptx`);
  const executed = exec.runs.length > 0;
  const facts = {
    classification: cls,
    reproduction_plan: { ...plan, scripts: plan.scripts?.map((s) => ({ name: s.name, purpose: s.purpose })) },
    execution: { executed, allSucceeded: exec.allSucceeded, runs: exec.runs.map((r) => ({ script: r.script, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs })), outputs: exec.outputs.map((o) => o.path) },
    reproduction_verdict: verdict,
    fixed_fields: {
      'metadata.review_protocol_version': '8.0',
      'metadata.paper_title': title,
      'metadata.manuscript_language': lang,
      'metadata.target_venue': ctx.task.options.targetVenue || 'general',
      'metadata.review_depth': ctx.task.options.reportDepth,
      'metadata.review_date': new Date().toISOString().slice(0, 10),
      'reproduction.verification_scope': verdict.verification_scope || 'reporting_only',
      'presentation.ppt_required': true,
      'presentation.ppt_route': cls.primary_category,
      'presentation.integration_skill': 'two-slide-paper-ppt-graphical-v3（独立 v3，经能元 PptxGenJS 适配层构建）',
      'presentation.output_pptx_path': pptxPath
    }
  };
  const ref = CATEGORY_REFERENCE[cls.primary_category];
  const messages = [
    { role: 'system' as const, content: systemPrompt('资深电力/能源领域同行评审专家') },
    {
      role: 'user' as const,
      content: [
        '技能规则（paper-peer-review v8 SKILL.md）：', reviewSkillCore().slice(0, 60_000),
        reviewReference('review-protocol.md'), reviewReference('report-schema.md'), reviewReference('power-system-review-memory.md'),
        ref ? reviewReference(ref) : '', reviewReference('theoretical-analysis.md'), reviewReference('latest-literature-comparison.md'),
        `论文地图：<tool_output>${JSON.stringify(map).slice(0, 160_000)}</tool_output>`,
        `证据矩阵：<tool_output>${JSON.stringify(evidence).slice(0, 80_000)}</tool_output>`,
        `复现事实（本地真实执行记录，评审必须以此为准）：<tool_output>${JSON.stringify(facts).slice(0, 60_000)}</tool_output>`,
        supplements.length ? `补充材料 / 旧审稿意见 / 作者回复：<attachment>${JSON.stringify(supplements).slice(0, 80_000)}</attachment>` : '',
        ctx.task.options.searchLatestLiterature
          ? '最新文献：本系统当前没有联网检索工具。只能列出你确信真实存在、题目/年份/期刊准确的相关工作，并把 acquisition_status 设为 not_assessable、available_before_submission 设为 null；不确定就不要列。不要编造 DOI。'
          : '最新文献：用户关闭了检索，recent_relevant_works 为空，comparison_status 为 not_assessable。',
        `严格按 report-schema.md 输出完整的 canonical review JSON。fixed_fields 中的值必须原样使用。knowledge_application.checks 必须包含 M01–M04，再按证据触发其余规则。${executed ? '' : '本次没有执行复现：issues[].evidence_basis 不能是 reviewer_execution。'}presentation.reproduction_chart_data 只能引用 reproduction_verdict.chart_candidates 中的真实文件；没有可靠数值就用 data_origin=reproduction_barrier。${lang === 'en' ? '论文是英文：issues 等正文字段用英文书写，并另外给出 "zh" 字段，内含与英文完全对应的中文版本（同编号、同严重度、同结论）。' : '论文是中文：所有正文字段用中文书写。'}`,
        '结论等级必须由已核实的问题决定；模拟数据运行正常不代表应当接收。无法检验时用 unable_to_assess 或在 limitations_of_review 写明。'
      ].filter(Boolean).join('\n\n')
    }
  ];
  let record = await askJson<ReviewRecord>(ctx, 'academic_review', messages, 80_000);
  const out = reviewJsonPath(ctx);
  for (let round = 1; round <= 3; round += 1) {
    record.metadata = { ...(record.metadata || {}), review_protocol_version: '8.0', paper_title: title, manuscript_language: lang };
    record.presentation = { ...(record.presentation || {}), ppt_required: true, ppt_route: cls.primary_category, output_pptx_path: pptxPath };
    writeJsonAtomic(out, record);
    const check = await runSkillScript(ctx, REVIEW_SKILL_DIR, 'validate_review.py', [out]);
    if (check.ok) {
      await ctx.log(`评审 JSON 通过 v8 校验（第 ${round} 轮）`, 'success');
      return { outputs: [out], summary: { decision: (record.verdict as { decision?: string } | undefined)?.decision, issues: record.issues?.length || 0, rounds: round } };
    }
    await ctx.log(`评审 JSON 第 ${round} 轮未通过 v8 校验：${check.output.slice(0, 400)}`, 'warn');
    if (round === 3) throw new Error(`评审 JSON 三轮修正后仍未通过 v8 校验：${check.output.slice(0, 600)}`);
    record = await askJson<ReviewRecord>(ctx, 'academic_review', [
      ...messages,
      { role: 'assistant', content: JSON.stringify(record).slice(0, 120_000) },
      { role: 'user', content: `v8 validate_review.py 报错如下，请只修正这些问题，其余科学内容保持不变，输出完整 JSON：\n<tool_output>${check.output.slice(0, 4000)}</tool_output>` }
    ], 80_000);
  }
  throw new Error('unreachable');
};

/** 从 review.json 渲染 Word：中文论文出中文；英文论文出英文 + 对应中文。 */
export const stageReportRender: StageFn = async (ctx) => {
  const record = readJson<ReviewRecord & { zh?: Record<string, unknown> }>(reviewJsonPath(ctx), {} as never);
  const lang = record.metadata.manuscript_language === 'en' ? 'en' : 'zh';
  const title = safeFileName(String(record.metadata.paper_title || ctx.task.title));
  const outputs: string[] = [];
  const render = async (input: string, output: string, ui: 'zh-CN' | 'en') => {
    const r = await runSkillScript(ctx, REVIEW_SKILL_DIR, 'render_word_report.py', ['--input', input, '--output', output, '--ui-language', ui], 180_000);
    if (!r.ok || !fs.existsSync(output)) throw new Error(`Word 渲染失败：${r.output.slice(0, 500)}`);
    outputs.push(output);
  };
  if (lang === 'en') {
    await render(reviewJsonPath(ctx), P(ctx, 'review', `${title}_Review_English.docx`), 'en');
    if (!record.zh || typeof record.zh !== 'object') throw new Error('英文论文缺少对应的中文评审内容（review.json 的 zh 字段）。');
    const zhPath = P(ctx, 'review', 'review.zh.json');
    writeJsonAtomic(zhPath, { ...record, ...record.zh, metadata: record.metadata, zh: undefined });
    await render(zhPath, P(ctx, 'review', `${title}审稿意见_中文.docx`), 'zh-CN');
  } else {
    await render(reviewJsonPath(ctx), P(ctx, 'review', `${title}审稿意见.docx`), 'zh-CN');
  }
  // 抽查 Word 能被正常打开且包含正文
  const mammoth = await import('mammoth');
  for (const file of outputs) {
    const text = (await mammoth.extractRawText({ buffer: fs.readFileSync(file) })).value;
    if (text.trim().length < 500) throw new Error(`生成的 Word 内容过少：${file}`);
  }
  await ctx.log(`已生成评审报告：${outputs.map((f) => f.split(/[\\/]/).pop()).join('、')}`, 'success');
  return { outputs: [reviewJsonPath(ctx), ...outputs], summary: { files: outputs.length, language: lang } };
};
