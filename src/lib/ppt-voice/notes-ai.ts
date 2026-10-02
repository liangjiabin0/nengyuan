import fs from 'node:fs';
import { jsonrepair } from 'jsonrepair';
import sharp from 'sharp';
import { z } from 'zod';
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { completeChat, streamChat, stripThinkTags } from '@/lib/llm';
import { getModelEndpoint } from '@/lib/config';
import { exportPptVoiceSlideImages } from './orchestrator';
import type { PptVoiceMessage, PptVoiceSlide } from './types';
import { pptVoiceSlideImagePath } from './workspace';

const noteItemSchema = z.object({
  slideIndex: z.number().int().positive(),
  notes: z.string().trim().min(1).max(4000)
});

const notesPayloadSchema = z.object({
  slides: z.array(noteItemSchema).min(1).max(80)
});

export type PptVoiceChatIntent = {
  kind: 'generate' | 'polish' | 'chat';
  scope: 'all' | 'empty' | 'one';
  slideIndex?: number;
};

export type PptVoiceNoteUpdate = { slideIndex: number; notes: string };

export type PptVoiceChatProgress = {
  thought?: string;
  reply?: string;
  applied?: PptVoiceNoteUpdate[];
};

const VISION_BATCH = 1;
const VISION_MAX_WIDTH = 1280;

function pickNoteModel() {
  const settings = getModelEndpoint('small');
  return { ...settings, think: false };
}

function isFatalLlmError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /LLM HTTP 5\d\d|连接失败|无响应|timeout|aborted|AbortError/i.test(message);
}

async function ensureSlideImages(projectId: string, slides: PptVoiceSlide[]) {
  const missing = slides.some((slide) => !fs.existsSync(pptVoiceSlideImagePath(projectId, slide.slideIndex)));
  if (!missing) return;
  await exportPptVoiceSlideImages(projectId);
}

async function slideImagePart(projectId: string, slideIndex: number): Promise<ChatCompletionContentPart | null> {
  const filePath = pptVoiceSlideImagePath(projectId, slideIndex);
  if (!fs.existsSync(filePath)) return null;
  try {
    const jpeg = await sharp(filePath)
      .resize({ width: VISION_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        detail: 'high'
      }
    };
  } catch {
    const png = fs.readFileSync(filePath);
    return {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${png.toString('base64')}`,
        detail: 'high'
      }
    };
  }
}

async function visionUserContent(projectId: string, slides: PptVoiceSlide[], text: string) {
  const parts: ChatCompletionContentPart[] = [];
  for (const slide of slides) {
    const image = await slideImagePart(projectId, slide.slideIndex);
    if (!image) {
      throw new Error(`第 ${slide.slideIndex} 页还没有预览图，无法用视觉写稿。请等幻灯片预览导出完成后再试。`);
    }
    parts.push({ type: 'text', text: `【第 ${slide.slideIndex} 页画面】` });
    parts.push(image);
  }
  parts.push({ type: 'text', text });
  return parts;
}

function extractJsonObject(answer: string) {
  const unfenced = answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  if (start < 0) throw new Error('模型未返回 JSON。');
  const end = unfenced.lastIndexOf('}');
  return unfenced
    .slice(start, end > start ? end + 1 : undefined)
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export function parseNotesPayload(answer: string) {
  const raw = extractJsonObject(answer);
  const candidates = [raw];
  try {
    candidates.push(jsonrepair(raw));
  } catch {
    // keep raw
  }
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return notesPayloadSchema.parse(JSON.parse(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('备注 JSON 校验失败。');
}

export function publicAssistantReply(content: string) {
  return stripThinkTags(content)
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/\{[\s\S]*"slides"\s*:\s*\[[\s\S]*\}\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function detectPptVoiceChatIntent(question: string): PptVoiceChatIntent {
  const compact = question.replace(/\s+/g, '');
  const page = compact.match(/第(\d+)页/);
  const wantsWrite = /生成|撰写|写|补全|重写|演讲稿|讲稿|备注/.test(compact);
  const wantsPolish = /润色|改口吻|统一口吻|缩短|压到|口语化/.test(compact);
  const wantsAll = /全部|所有页|每一页|整份|全文/.test(compact);
  const wantsEmpty = /空页|没有备注|缺备注|没写备注/.test(compact);

  if (page && (wantsWrite || wantsPolish) && !wantsAll) {
    return {
      kind: wantsPolish && !/生成|撰写|重写/.test(compact) ? 'polish' : 'generate',
      scope: 'one',
      slideIndex: Number(page[1])
    };
  }
  if (wantsPolish && wantsAll) return { kind: 'polish', scope: 'all' };
  if (wantsWrite && wantsEmpty) return { kind: 'generate', scope: 'empty' };
  if (wantsWrite && wantsAll) return { kind: 'generate', scope: 'all' };
  if (/生成全部演讲稿|写完全部|全部演讲/.test(compact)) return { kind: 'generate', scope: 'all' };
  return { kind: 'chat', scope: 'all' };
}

function slideBrief(slide: PptVoiceSlide) {
  return [
    `第 ${slide.slideIndex} 页`,
    slide.title ? `标题：${slide.title}` : '标题：（无）',
    slide.bodyText ? `正文：${slide.bodyText.slice(0, 900)}` : '正文：（无）',
    slide.notes ? `现有备注：${slide.notes}` : '现有备注：（空）'
  ].join('\n');
}

const SYSTEM_NOTES = [
  '你是电力 / 能源科研汇报的演讲稿写手。',
  '必须观看用户消息中附带的幻灯片画面来写稿；抽出的标题/正文只作辅助，图表、公式、坐标轴和数字以画面为准。',
  '画面上看不见的数据不要编造。不要念“本页”“如图所示”；不要 Markdown；不要编号清单腔。',
  '每页 80 到 220 字，技术名词保留，数字按中文口语可读。',
  '只输出一个 JSON 对象：{"slides":[{"slideIndex":1,"notes":"..."}]}。'
].join('');

function filterNoteUpdates(slides: PptVoiceSlide[], parsed: { slides: PptVoiceNoteUpdate[] }) {
  const allowed = new Set(slides.map((slide) => slide.slideIndex));
  return parsed.slides.filter((item) => allowed.has(item.slideIndex));
}

async function generateNoteBatch(
  projectId: string,
  slides: PptVoiceSlide[],
  instruction: string | undefined,
  signal?: AbortSignal,
  onThought?: (text: string) => void
) {
  const settings = pickNoteModel();
  const text = [
    instruction ? `额外要求：${instruction}` : '',
    '请根据附带的幻灯片画面生成或改写演讲者备注：',
    slides.map(slideBrief).join('\n\n')
  ]
    .filter(Boolean)
    .join('\n\n');
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_NOTES },
    { role: 'user', content: await visionUserContent(projectId, slides, text) }
  ];
  const options = { max_tokens: 4096, temperature: 0.4, thinking: false, settings, signal };
  try {
    const content = (await streamChat(messages, { ...options, onThought })).content;
    return filterNoteUpdates(slides, parseNotesPayload(content));
  } catch (error) {
    if (isFatalLlmError(error) || signal?.aborted) throw error;
    const content = (await completeChat(messages, options)).content;
    return filterNoteUpdates(slides, parseNotesPayload(content));
  }
}

export async function generatePptVoiceNotes(
  slides: PptVoiceSlide[],
  options: {
    projectId: string;
    instruction?: string;
    signal?: AbortSignal;
    onProgress?: (info: { current: number; total: number; message: string }) => void;
    onThought?: (text: string) => void;
    onBatch?: (updates: PptVoiceNoteUpdate[]) => void | Promise<void>;
  }
) {
  if (!slides.length) throw new Error('没有可处理的幻灯片。');
  await ensureSlideImages(options.projectId, slides);
  const extra = options.instruction?.trim();
  const result: PptVoiceNoteUpdate[] = [];
  for (let index = 0; index < slides.length; index += VISION_BATCH) {
    const batch = slides.slice(index, index + VISION_BATCH);
    const from = batch[0].slideIndex;
    const to = batch[batch.length - 1].slideIndex;
    options.onProgress?.({
      current: index + 1,
      total: slides.length,
      message: `正在看图撰写第 ${from}${from === to ? '' : `–${to}`} 页演讲稿`
    });
    const updates = await generateNoteBatch(options.projectId, batch, extra, options.signal, options.onThought);
    result.push(...updates);
    await options.onBatch?.(updates);
  }
  return result;
}

function selectSlides(slides: PptVoiceSlide[], intent: PptVoiceChatIntent) {
  if (intent.scope === 'one') {
    return slides.filter((slide) => slide.slideIndex === intent.slideIndex);
  }
  if (intent.scope === 'empty') {
    return slides.filter((slide) => !slide.notes.trim());
  }
  return slides;
}

function mentionedSlideIndexes(question: string, slides: PptVoiceSlide[]) {
  const allowed = new Set(slides.map((slide) => slide.slideIndex));
  return [...new Set([...question.matchAll(/第\s*(\d+)\s*页/g)].map((match) => Number(match[1])))]
    .filter((index) => allowed.has(index))
    .slice(0, 4);
}

export async function chatPptVoiceAssistant(input: {
  projectId: string;
  slides: PptVoiceSlide[];
  messages: PptVoiceMessage[];
  question: string;
  signal?: AbortSignal;
  onProgress?: (event: PptVoiceChatProgress) => void;
}) {
  const intent = detectPptVoiceChatIntent(input.question);
  const emit = (event: PptVoiceChatProgress) => input.onProgress?.(event);

  if (intent.kind !== 'chat') {
    const selected = selectSlides(input.slides, intent);
    if (!selected.length) {
      const reply = intent.scope === 'empty' ? '没有空备注页需要补全。' : '没有可处理的页面。';
      emit({ thought: reply, reply });
      return { reply, applied: [] as PptVoiceNoteUpdate[], intent };
    }
    const instruction = intent.kind === 'polish'
      ? `在现有备注基础上润色为更适合口头汇报的讲稿，不要改变技术含义。${input.question}`
      : input.question;
    emit({
      thought: `已理解：对照画面为 ${selected.length} 页${intent.kind === 'polish' ? '润色' : '撰写'}演讲稿`,
      reply: `好的，我开始看图为 ${selected.length} 页写演讲稿。`
    });
    const applied: PptVoiceNoteUpdate[] = [];
    await generatePptVoiceNotes(selected, {
      projectId: input.projectId,
      instruction,
      signal: input.signal,
      onThought: (text) => emit({ thought: text }),
      onProgress: (info) => emit({
        thought: info.message,
        reply: `正在看图撰写演讲稿… ${Math.min(info.current + VISION_BATCH, info.total)}/${info.total} 页`
      }),
      onBatch: (updates) => {
        applied.push(...updates);
        emit({
          applied: updates,
          thought: `已写入第 ${updates.map((item) => item.slideIndex).join('、')} 页`,
          reply: `已完成 ${applied.length}/${selected.length} 页演讲稿。`
        });
      }
    });
    const reply = `已为 ${applied.length} 页写好演讲者备注，可在中间栏查看、修改或试听。`;
    emit({ thought: `已完成 ${applied.length} 页`, reply });
    return { reply, applied, intent };
  }

  const settings = pickNoteModel();
  const catalog = input.slides
    .map((slide) => {
      const noteHint = slide.notes.trim() ? `备注${slide.notes.length}字` : '无备注';
      return `${slide.slideIndex}. ${slide.title || '（无标题）'} · ${noteHint}`;
    })
    .join('\n');
  const history = input.messages.slice(-12).map((item) => ({
    role: item.role as 'user' | 'assistant',
    content: publicAssistantReply(item.content) || item.content
  }));
  const visualSlides = mentionedSlideIndexes(input.question, input.slides)
    .map((slideIndex) => input.slides.find((slide) => slide.slideIndex === slideIndex))
    .filter((slide): slide is PptVoiceSlide => Boolean(slide));
  if (visualSlides.length) await ensureSlideImages(input.projectId, visualSlides);
  const userContent = visualSlides.length
    ? await visionUserContent(input.projectId, visualSlides, input.question)
    : input.question;
  const systemChat = [
    '你是 PPT 智能配音助手，帮助用户改写演讲者备注、控制时长、统一口吻。',
    '若消息中附带了幻灯片画面，改稿必须以画面为准，不要编造图上看不见的数据。',
    '先用简短中文回复用户，说明你改了什么。',
    '若要改写备注，在回答末尾附加 JSON：{"slides":[{"slideIndex":1,"notes":"..."}]}。',
    '一次最多改 8 页。',
    '',
    '当前幻灯片目录：',
    catalog || '（空）'
  ].join('\n');
  emit({ thought: visualSlides.length ? '正在对照幻灯片画面理解你的要求' : '正在对照幻灯片目录理解你的要求' });
  let streamed = '';
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemChat },
    ...history,
    { role: 'user', content: userContent }
  ];
  const { content } = await streamChat(
    messages,
    {
      max_tokens: 4096,
      temperature: 0.4,
      thinking: false,
      settings,
      signal: input.signal,
      onThought: (text) => emit({ thought: text }),
      onDelta: (text) => {
        streamed = publicAssistantReply(text) || text;
        if (streamed) emit({ reply: streamed });
      }
    }
  ).catch(async () => completeChat(messages, {
    max_tokens: 4096,
    temperature: 0.4,
    thinking: false,
    settings,
    signal: input.signal
  }));

  let applied: PptVoiceNoteUpdate[] = [];
  try {
    applied = parseNotesPayload(content).slides;
    const allowed = new Set(input.slides.map((slide) => slide.slideIndex));
    applied = applied.filter((item) => allowed.has(item.slideIndex));
  } catch {
    applied = [];
  }
  const reply = publicAssistantReply(content)
    || (applied.length ? `已按你的要求更新 ${applied.length} 页备注。` : content.trim());
  emit({ reply, applied, thought: applied.length ? `已更新 ${applied.length} 页备注` : '已完成回复' });
  return { reply, applied, intent };
}
