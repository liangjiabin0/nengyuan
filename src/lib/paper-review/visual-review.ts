import fs from 'node:fs';
import path from 'node:path';
import { callPaperReviewModel, type ModelUsageRecord } from './llm';
import { sha256File } from './workspace';

type Endpoint = Parameters<typeof callPaperReviewModel>[0];

export type SlideReview = {
  slide: 1 | 2;
  renderPath: string;
  renderSha256: string;
  checks: Record<string, boolean>;
  observations: string;
  problems: string[];
};

const SLIDE1_CHECKS = ['readable', 'noOverlap', 'templateMatch', 'evidenceFaithful', 'editable', 'mechanismClear', 'notTextOnly', 'formulaAdjacency'];
const SLIDE2_CHECKS = ['readable', 'noOverlap', 'templateMatch', 'evidenceFaithful', 'editable'];

/** 渲染图压缩成 JPEG 再发给模型，减少 token。 */
async function toDataUrl(png: string, python: string) {
  const { runControlled, sandboxEnv } = await import('./process');
  const jpg = png.replace(/\.png$/i, '.review.jpg');
  const code = `from PIL import Image\nim=Image.open(r'''${png}''').convert('RGB');im.thumbnail((1600,1600));im.save(r'''${jpg}''',quality=85)`;
  const r = await runControlled(python, ['-c', code], { cwd: path.dirname(png), timeoutMs: 60_000, env: sandboxEnv() });
  const file = r.exitCode === 0 && fs.existsSync(jpg) ? jpg : png;
  const mime = file.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

/**
 * 最终渲染视觉审核：模型实际查看 PowerPoint 渲染出的两张图，逐项判断 v3 要求的检查项，
 * 结果写成 visual-review.json，并绑定最终 PPTX、语义图、布局、覆盖清单和渲染图的 hash。
 * 任何一项为 false 都会让 v3 audit_graphic_delivery.py 判定未通过。
 */
export async function reviewRenderedSlides(input: {
  endpoint: Endpoint;
  python: string;
  pptx: string;
  renders: [string, string];
  graphPath: string;
  layoutPath: string;
  coveragePath: string;
  specSummary: string;
  outPath: string;
  signal?: AbortSignal;
}): Promise<{ review: Record<string, unknown>; usage: ModelUsageRecord[]; passed: boolean; problems: string[] }> {
  const usage: ModelUsageRecord[] = [];
  const slides: SlideReview[] = [];
  for (const [index, render] of input.renders.entries()) {
    const slide = (index + 1) as 1 | 2;
    const checks = slide === 1 ? SLIDE1_CHECKS : SLIDE2_CHECKS;
    const image = await toDataUrl(render, input.python);
    const prompt = [
      `这是两页论文评审 PPT 中第 ${slide} 页由 PowerPoint 实际导出的渲染图。请像审稿人一样仔细看图，只描述你在图中真正看到的内容。`,
      `设计意图摘要（用于对照，不代表图中一定做到了）：\n${input.specSummary}`,
      `逐项判断（true 表示确实满足）：`,
      `- readable：所有文字清晰可读，没有截断或溢出文本框`,
      `- noOverlap：文字、形状、连线、图表之间没有不应有的遮挡或重叠`,
      `- templateMatch：标题、摘要框、配色与学术模板风格一致`,
      `- evidenceFaithful：图中数值、标签与设计意图一致，没有出现意图中不存在的数据`,
      `- editable：从外观判断，图表、表格、机制图是原生对象而非整页截图（截图通常有模糊或压缩痕迹）`,
      ...(slide === 1
        ? ['- mechanismClear：机制图能看清节点之间的方向关系（箭头、连线走向明确）', '- notTextOnly：不是一堆文字卡片的罗列，而是有结构的图', '- formulaAdjacency：公式放在与之相关的环节旁边，且公式渲染完整']
        : []),
      '输出 JSON：{"checks":{检查项:true/false},"observations":"至少 60 字的具体观察，指出看到了哪些对象和位置","problems":["需要修复的具体问题，没有则为空数组"]}'
    ].join('\n');
    const { text, usage: u } = await callPaperReviewModel(input.endpoint, [
      { role: 'system', content: '你是严格的学术幻灯片视觉审核员。只依据图像判断，输出合法 JSON。' },
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] }
    ], { stage: `ppt_render_audit:slide${slide}`, signal: input.signal, json: true, maxTokens: 4000 });
    usage.push(u);
    let parsed: { checks?: Record<string, unknown>; observations?: string; problems?: unknown[] } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { checks: {}, observations: '', problems: ['视觉审核返回的不是合法 JSON'] };
    }
    const result: Record<string, boolean> = {};
    for (const key of checks) result[key] = parsed.checks?.[key] === true;
    slides.push({
      slide,
      renderPath: path.relative(path.dirname(input.outPath), render).split(path.sep).join('/'),
      renderSha256: sha256File(render),
      checks: result,
      observations: String(parsed.observations || ''),
      problems: (parsed.problems || []).map(String).filter(Boolean)
    });
  }
  const review = {
    reviewer: 'model-visual-review',
    reviewedAt: new Date().toISOString(),
    pptxSha256: sha256File(input.pptx),
    graphSha256: sha256File(input.graphPath),
    layoutSha256: sha256File(input.layoutPath),
    coverageSha256: sha256File(input.coveragePath),
    slides
  };
  fs.writeFileSync(input.outPath, JSON.stringify(review, null, 2));
  const problems = slides.flatMap((s) => [
    ...Object.entries(s.checks).filter(([, ok]) => !ok).map(([k]) => `第 ${s.slide} 页未通过：${k}`),
    ...s.problems.map((p) => `第 ${s.slide} 页：${p}`)
  ]);
  const passed = slides.every((s) => Object.values(s.checks).every(Boolean) && s.observations.trim().length >= 40);
  return { review, usage, passed, problems };
}
