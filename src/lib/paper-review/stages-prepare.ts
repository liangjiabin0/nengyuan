import { probePaperReviewModel } from './llm';
import { chunkText, parsePaperFile, type ParsedPaper } from './parse';
import { reviewReference, systemPrompt, wrapManuscript } from './prompts';
import { P, StageBlockedError, askJson, type Ctx, type StageFn } from './stage-kit';
import { updatePaperReviewTask } from './store';
import { readJson, writeJsonAtomic } from './workspace';

export const paperFile = (ctx: Ctx) => {
  const paper = ctx.task.inputs.find((i) => i.role === 'paper');
  if (!paper) throw new StageBlockedError('没有上传主论文文件。');
  return P(ctx, paper.path);
};

export const loadParsed = (ctx: Ctx) => readJson<ParsedPaper | null>(P(ctx, 'work', 'parsed.json'), null);

export const stagePreflight: StageFn = async (ctx) => {
  if (!ctx.task.options.allowExternalModel) {
    throw new StageBlockedError('论文内容需要发送给外部模型服务处理。请在任务设置中勾选“允许把论文内容发送给配置的模型服务”后再运行。');
  }
  const probe = await probePaperReviewModel();
  const out = P(ctx, 'work', 'preflight.json');
  writeJsonAtomic(out, {
    probe,
    endpoint: { kind: ctx.endpoint.kind, model: ctx.endpoint.model, thinking: ctx.endpoint.thinking },
    python: ctx.python,
    skills: ctx.task.skills,
    checkedAt: new Date().toISOString()
  });
  await ctx.log(`模型：${ctx.endpoint.model}（思考 ${ctx.endpoint.thinking}${ctx.endpoint.kind === 'storm-fallback' ? '，已按设置回退到 Storm' : ''}），上游实际返回 ${probe.actualModel || '未知'}`);
  return { outputs: [out], summary: { model: ctx.endpoint.model, actualModel: probe.actualModel, fallback: ctx.endpoint.kind === 'storm-fallback' } };
};

export const stageParse: StageFn = async (ctx) => {
  const parsed = await parsePaperFile(paperFile(ctx));
  const supplements: Array<{ name: string; role: string; chars: number; text: string }> = [];
  for (const input of ctx.task.inputs.filter((i) => !['paper', 'code', 'data'].includes(i.role))) {
    try {
      const p = await parsePaperFile(P(ctx, input.path));
      supplements.push({ name: input.name, role: input.role, chars: p.chars, text: p.text.slice(0, 200_000) });
    } catch (error) {
      supplements.push({ name: input.name, role: input.role, chars: 0, text: `（无法解析：${error instanceof Error ? error.message : String(error)}）` });
    }
  }
  const out = P(ctx, 'work', 'parsed.json');
  const sup = P(ctx, 'work', 'supplements.json');
  writeJsonAtomic(out, parsed);
  writeJsonAtomic(sup, supplements);
  for (const w of parsed.warnings) await ctx.log(w, 'warn');
  if (parsed.chars < 1500) {
    throw new StageBlockedError('论文正文抽取到的文字太少（可能是扫描版 PDF），无法进行有依据的评审。请上传可复制文字的 PDF 或 DOCX。');
  }
  await ctx.log(`已解析论文：${parsed.pageCount || '?'} 页，${parsed.chars} 字，语言${parsed.language === 'zh' ? '中文' : '英文'}`);
  return { outputs: [out, sup], summary: { pages: parsed.pageCount, chars: parsed.chars, language: parsed.language, supplements: supplements.length } };
};

/** 超长论文分块阅读：逐块抽取结构化要点，再交给后续阶段。 */
async function buildPaperMap(ctx: Ctx, parsed: ParsedPaper) {
  const chunks = chunkText(parsed.text, 150_000);
  const notes: unknown[] = [];
  for (const [i, chunk] of chunks.entries()) {
    notes.push(await askJson(ctx, 'classify', [
      { role: 'system', content: systemPrompt('论文审稿助手') },
      {
        role: 'user',
        content: `${wrapManuscript(chunk)}\n\n这是论文第 ${i + 1}/${chunks.length} 部分。按 v8“Build the paper map”要求抽取本部分：研究问题、贡献、核心结论、数据/算例、模型与公式（含编号与 LaTeX）、算法流程、对比方法、假设、理论主张、数据/代码可用性声明、实现所需关键参数（含数值）。每条都带页码/节号/式号/表号/图号。输出 JSON：{"items":[{"kind":"","content":"","location":"","latex":"可选"}]}`
      }
    ], 24_000));
  }
  const map = { chunks: chunks.length, notes };
  writeJsonAtomic(P(ctx, 'work', 'paper-map.json'), map);
  return map;
}

export const stageClassify: StageFn = async (ctx) => {
  const parsed = loadParsed(ctx);
  if (!parsed) throw new Error('缺少论文解析结果');
  const map = await buildPaperMap(ctx, parsed);
  const result = await askJson<{ title: string; primary_category: string; secondary_category: string | null; rationale: string; paper_type_for_ppt: string }>(ctx, 'classify', [
    { role: 'system', content: systemPrompt('论文审稿助手') },
    {
      role: 'user',
      content: `${reviewReference('paper-classification.md')}\n\n论文地图：\n<tool_output>${JSON.stringify(map).slice(0, 200_000)}</tool_output>\n\n按上述分类规则，以主要科学贡献（不是关键词）给论文分类。输出 JSON：{"title":"论文正式题目（原文语言）","primary_category":"data_science|optimization_planning_operation|system_stability_control","secondary_category":null,"rationale":"依据，带位置","paper_type_for_ppt":"planning|forecasting|control"}`
    }
  ]);
  const valid = ['data_science', 'optimization_planning_operation', 'system_stability_control'];
  if (!valid.includes(result.primary_category)) throw new Error(`分类结果不合法：${result.primary_category}`);
  if (!['planning', 'forecasting', 'control'].includes(result.paper_type_for_ppt)) {
    result.paper_type_for_ppt = result.primary_category === 'data_science' ? 'forecasting' : result.primary_category === 'system_stability_control' ? 'control' : 'planning';
  }
  const out = P(ctx, 'work', 'classification.json');
  writeJsonAtomic(out, { ...result, language: parsed.language });
  if (result.title) await updatePaperReviewTask(ctx.task.id, { title: result.title.slice(0, 300) });
  await ctx.log(`论文分类：${result.primary_category}${result.secondary_category ? ` / ${result.secondary_category}` : ''}`);
  return { outputs: [out, P(ctx, 'work', 'paper-map.json')], summary: { category: result.primary_category, title: result.title } };
};

export const stageEvidenceMap: StageFn = async (ctx) => {
  const map = readJson(P(ctx, 'work', 'paper-map.json'), {});
  const cls = readJson<{ primary_category: string }>(P(ctx, 'work', 'classification.json'), { primary_category: '' });
  const supplements = readJson<unknown[]>(P(ctx, 'work', 'supplements.json'), []);
  const result = await askJson<Record<string, unknown>>(ctx, 'evidence_map', [
    { role: 'system', content: systemPrompt('论文审稿助手') },
    {
      role: 'user',
      content: [
        reviewReference('experimental-support-reproducibility.md'),
        reviewReference('variable-symbol-audit.md'),
        reviewReference('data-availability-reproduction.md'),
        `论文分类：${cls.primary_category}`,
        `论文地图：<tool_output>${JSON.stringify(map).slice(0, 220_000)}</tool_output>`,
        supplements.length ? `补充材料 / 旧审稿意见 / 作者回复：<attachment>${JSON.stringify(supplements).slice(0, 120_000)}</attachment>` : '',
        '建立“主张→证据→方法→假设→结果→结论”证据矩阵；完成变量/符号审计（正式表最多 3 个真正未定义含义的符号；已定义但缺数值的参数放 parameter_configuration_gaps）；完成数据/代码可用性审计；列出关键公式（LaTeX，带编号与位置）。若提供了旧审稿意见或作者回复，revision_mode=true。',
        '输出 JSON：{"claims":[{"id":"C1","claim":"","location":"","supporting_evidence":[""],"method":"","assumptions":[""],"result":"","support_status":"supported|partially_supported|unsupported|not_assessable","evidence_assessment":"","required_resolution":""}],"undefined_variables":[{"symbol":"","location":"","missing_definition":true,"problem":"","impact":"","severity":"major|moderate|minor"}],"parameter_configuration_gaps":[{"parameter":"","location":"","gap":"","impact":""}],"data_code_availability":{"data_status":"","code_status":"","evidence":"","gaps":[""]},"key_equations":[{"label":"","latex":"","location":"","meaning":""}],"revision_mode":false}'
      ].filter(Boolean).join('\n\n')
    }
  ], 40_000);
  const claims = Array.isArray(result.claims) ? result.claims.length : 0;
  if (!claims) throw new Error('证据矩阵没有识别出任何核心主张。');
  const out = P(ctx, 'work', 'evidence-map.json');
  writeJsonAtomic(out, result);
  await ctx.log(`证据矩阵：${claims} 个核心主张`);
  return { outputs: [out], summary: { claims } };
};
