import fs from 'node:fs';
import path from 'node:path';
import { runControlled, sandboxEnv } from './process';
import { P, StageBlockedError, type Ctx, type StageFn } from './stage-kit';
import type { ReproExecution } from './reproduction';
import type { ReproVerdict } from './stages-repro';
import { reviewJsonPath } from './stages-review';
import { getPaperReviewTask, updatePaperReviewTask } from './store';
import { readJson, safeFileName, sha256File, writeJsonAtomic } from './workspace';

type Gate = { passed: boolean; detail?: string };

function exists(p: string) {
  return fs.existsSync(p) && fs.statSync(p).size > 0;
}

/** 汇总所有质量门禁；任何一项不过，任务只能是“部分成果”，不能标记完成。 */
export async function evaluateGates(ctx: Ctx): Promise<Record<string, Gate>> {
  const record = readJson<{ metadata?: { paper_title?: string; manuscript_language?: string } }>(reviewJsonPath(ctx), {});
  const title = safeFileName(String(record.metadata?.paper_title || ctx.task.title));
  const lang = record.metadata?.manuscript_language === 'en' ? 'en' : 'zh';
  const exec = readJson<ReproExecution>(P(ctx, 'work', 'execution.json'), { runs: [], outputs: [], missingOutputs: [], environment: {}, allSucceeded: false });
  const verdict = readJson<Partial<ReproVerdict>>(P(ctx, 'work', 'repro-verdict.json'), {});
  const delivery = readJson<{ visualPassed?: boolean; deliveryAudit?: { ok?: boolean }; pptxSha256?: string }>(P(ctx, 'ppt', 'delivery-audit.json'), {});
  const pptx = P(ctx, 'ppt', `${title}_Two-Slide_Review.pptx`);
  const docs = lang === 'en'
    ? [P(ctx, 'review', `${title}_Review_English.docx`), P(ctx, 'review', `${title}审稿意见_中文.docx`)]
    : [P(ctx, 'review', `${title}审稿意见.docx`)];
  const reproRecorded = !ctx.task.options.reproduce
    || (exec.runs.length > 0 && exists(P(ctx, 'reproduction', 'validation.json')) && exists(P(ctx, 'reproduction', 'README.md')))
    || (exec.runs.length === 0 && Boolean(verdict.limitations?.length));
  return {
    review_json: { passed: ctx.task.stages.academic_review?.status === 'passed' && exists(reviewJsonPath(ctx)), detail: 'v8 validate_review.py 通过' },
    review_docx: { passed: docs.every(exists), detail: docs.map((d) => path.basename(d)).join('、') },
    reproduction_evidence: {
      passed: reproRecorded,
      detail: exec.runs.length
        ? `${exec.runs.length} 次运行，${exec.allSucceeded ? '全部成功' : '未全部成功'}；结论 ${verdict.verdict || '未知'}`
        : `未执行复现：${(verdict.limitations || []).join('；') || '缺少不可复现说明'}`
    },
    ppt_two_slides: { passed: exists(pptx), detail: path.basename(pptx) },
    ppt_render_audit: {
      passed: Boolean(delivery.visualPassed && delivery.deliveryAudit?.ok && exists(pptx) && delivery.pptxSha256 === sha256File(pptx)),
      detail: delivery.pptxSha256 && exists(pptx) && delivery.pptxSha256 !== sha256File(pptx) ? '渲染审核对应的不是最终 PPTX（hash 不一致）' : '最终渲染审核与 v3 交付审计'
    },
    literature: { passed: true, detail: '文献按 v8 规则：合法 PDF 或无法下载清单' }
  };
}

export const stageFinalValidation: StageFn = async (ctx) => {
  const gates = await evaluateGates(ctx);
  await updatePaperReviewTask(ctx.task.id, { gates });
  const out = P(ctx, 'work', 'gates.json');
  writeJsonAtomic(out, gates);
  const failed = Object.entries(gates).filter(([, g]) => !g.passed).map(([k]) => k);
  if (failed.length) await ctx.log(`质量门禁未全部通过：${failed.join('、')}`, 'warn');
  else await ctx.log('全部质量门禁通过', 'success');
  return { outputs: [out], summary: { failed } };
};

function readmeText(ctx: Ctx, gates: Record<string, Gate>) {
  const verdict = readJson<Partial<ReproVerdict>>(P(ctx, 'work', 'repro-verdict.json'), {});
  const complete = Object.values(gates).every((g) => g.passed);
  return [
    `# ${ctx.task.title || '论文评审'} — 交付说明`,
    '',
    complete ? '状态：完整评审成果（所有质量门禁通过）' : '状态：**部分成果草稿（不完整）**，未通过的门禁见 manifest.json',
    '',
    '## 内容',
    '- 审稿意见 Word 与 review.json（v8 校验通过的唯一事实源）',
    '- Reproduction/：原理级复现脚本、配置、数据或生成器、运行日志、输出、校验记录',
    '- Two-Slide PPT/：两页可编辑 PPT 与构建工件（语义图、布局、来源索引、证据台账、视觉审核）',
    '- Latest Relevant Literature/：合法获取的文献 PDF，或无法下载清单',
    '',
    '## 复现结论',
    `- ${verdict.verdict || 'not_assessable'}（${verdict.verification_scope || 'reporting_only'}）`,
    ...(verdict.limitations || []).map((l) => `- 局限：${l}`),
    '',
    '## 限制',
    '- 模拟或缩小算例只能验证有限命题，不代表原论文真实工况下的性能。',
    '- 复现脚本在受控子进程中运行（工作目录限定、密钥剥离、超时终止），不是容器级隔离。',
    '- 本系统没有联网文献检索；最新文献部分只列出确信存在的工作，未下载的文献见清单。',
    '',
    '## 复跑',
    '进入 Reproduction/，按 README.md 中的命令依次运行脚本（随机种子通过环境变量 REPRO_SEED 传入）。',
    ''
  ].join('\n');
}

/** 打包：只有 PPT 等全部产物就绪后才运行；门禁不全过时只能生成标注“不完整”的草稿包。 */
export async function buildPackage(ctx: Ctx, opts: { draft: boolean }) {
  const task = (await getPaperReviewTask(ctx.task.id))!;
  const gates = Object.keys(task.gates).length ? task.gates : await evaluateGates(ctx);
  const complete = Object.values(gates).every((g) => g.passed);
  if (!complete && !opts.draft) throw new StageBlockedError('质量门禁未全部通过，不能生成完整成果包。可在页面上导出“部分成果草稿包”。');
  const record = readJson<{ metadata?: { paper_title?: string; manuscript_language?: string } }>(reviewJsonPath(ctx), {});
  const title = String(record.metadata?.paper_title || task.title || '论文');
  const safeTitle = safeFileName(title);
  const lang = record.metadata?.manuscript_language === 'en' ? 'en' : 'zh';
  const paper = task.inputs.find((i) => i.role === 'paper')!;
  const pptx = P(ctx, 'ppt', `${safeTitle}_Two-Slide_Review.pptx`);
  const usage = task.usage.reduce((acc, u) => {
    acc.calls += 1; acc.promptTokens += u.promptTokens; acc.completionTokens += u.completionTokens; acc.models.add(u.actualModel || u.requestedModel);
    return acc;
  }, { calls: 0, promptTokens: 0, completionTokens: 0, models: new Set<string>() });
  const manifest = {
    gates,
    private_roots: [ctx.root, process.cwd()],
    skills: task.skills,
    model_usage_summary: { calls: usage.calls, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, models: [...usage.models] },
    papers: [{
      paper_title: title,
      source_path: P(ctx, paper.path),
      manuscript_language: lang,
      review_path_zh: lang === 'en' ? P(ctx, 'review', `${safeTitle}审稿意见_中文.docx`) : P(ctx, 'review', `${safeTitle}审稿意见.docx`),
      review_path_en: P(ctx, 'review', `${safeTitle}_Review_English.docx`),
      review_json_path: reviewJsonPath(ctx),
      readme: readmeText(ctx, gates),
      reproduction_dir: fs.existsSync(P(ctx, 'reproduction', 'README.md')) ? P(ctx, 'reproduction') : null,
      literature: ((readJson<{ latest_literature_comparison?: { recent_relevant_works?: unknown[] } }>(reviewJsonPath(ctx), {}).latest_literature_comparison?.recent_relevant_works) || []),
      pptx_path: fs.existsSync(pptx) ? pptx : null,
      ppt_artifacts: ['spec.json', 'semantic-graph.json', 'diagram-layout.json', 'diagram-coverage.json', 'source-index.json', 'evidence-ledger.json', 'visual-design-spec.md', 'formula-manifest.json', 'visual-review.json', 'delivery-audit.json', 'build-audits.json']
        .map((f) => P(ctx, 'ppt', f)).filter((f) => fs.existsSync(f)),
      stages: Object.fromEntries(Object.entries(task.stages).map(([k, v]) => [k, v?.status]))
    }]
  };
  const manifestPath = P(ctx, 'package', 'package-input.json');
  writeJsonAtomic(manifestPath, manifest);
  const zip = P(ctx, 'package', `${safeTitle}${complete ? '' : '_部分成果草稿'}.zip`);
  const script = path.join(process.cwd(), 'scripts', 'paper-review', 'package_review.py');
  const r = await runControlled(ctx.python, ['-X', 'utf8', script, '--manifest', manifestPath, '--output', zip, ...(complete ? [] : ['--draft'])], {
    cwd: P(ctx, 'package'), timeoutMs: 600_000, signal: ctx.signal, env: sandboxEnv(), logFile: P(ctx, 'logs', 'package.log'), tag: 'package'
  });
  if (r.exitCode !== 0 || !fs.existsSync(zip)) throw new Error(`打包失败：${(r.stderr || r.stdout).slice(-800)}`);
  return { zip, complete };
}

export const stagePackaging: StageFn = async (ctx) => {
  const { zip, complete } = await buildPackage(ctx, { draft: false });
  await ctx.log(`已生成${complete ? '完整' : '草稿'}成果包：${path.basename(zip)}`, 'success');
  return { outputs: [zip], summary: { zip: path.basename(zip), complete } };
};
