import path from 'node:path';
import { callPaperReviewModel, type ChatMessage, type resolvePaperReviewEndpoint } from './llm';
import { runControlled, sandboxEnv } from './process';
import { frozenSkillPath } from './skills';
import { appendUsage, getPaperReviewTask, totalTokens, type PaperReviewTask } from './store';
import { STAGE_LABELS, type PaperReviewStage } from './types';

/** 一个任务一次运行中所有阶段共享的上下文。 */
export type Ctx = {
  task: PaperReviewTask;
  root: string;
  signal: AbortSignal;
  python: string;
  endpoint: ReturnType<typeof resolvePaperReviewEndpoint>;
  log: (text: string, level?: 'info' | 'warn' | 'error' | 'success', data?: unknown) => Promise<void>;
};

export type StageResult = { outputs: string[]; summary: Record<string, unknown> };
export type StageFn = (ctx: Ctx) => Promise<StageResult>;

/** 阶段因外部条件无法继续（缺数据、未授权、预算用完等）：任务标记为 blocked，而不是失败重试。 */
export class StageBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageBlockedError';
  }
}

export function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('任务已取消', 'AbortError');
}

export const P = (ctx: Ctx, ...rel: string[]) => path.join(ctx.root, ...rel);

const LAYOUT_STAGES = new Set<PaperReviewStage>(['ppt_plan', 'ppt_render_audit']);

/** 调用模型并解析 JSON，记录真实用量；超出任务 token 上限立即停下。 */
export async function askJson<T>(ctx: Ctx, stage: PaperReviewStage, messages: ChatMessage[], maxTokens = 32_000): Promise<T> {
  const fresh = await getPaperReviewTask(ctx.task.id);
  if (fresh && totalTokens(fresh) >= ctx.task.options.maxModelTokens) {
    throw new StageBlockedError(`模型用量已达到任务上限 ${ctx.task.options.maxModelTokens} tokens，已停止以免继续消耗。可在任务设置里调高上限后重试。`);
  }
  let convo = messages;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    checkAbort(ctx.signal);
    // 纯版式阶段（PPT 布局设计与局部修复）不涉及科学判断，用中等思考档位缩短单次响应，减少长时间无数据导致的连接中断
    const thinking = LAYOUT_STAGES.has(stage) && ctx.endpoint.thinking !== 'none' ? 'medium' : undefined;
    const { text, usage } = await callPaperReviewModel(ctx.endpoint, convo, { stage, signal: ctx.signal, json: true, maxTokens, thinking });
    await appendUsage(ctx.task.id, usage);
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      if (attempt === 2) throw new Error(`${STAGE_LABELS[stage]}：模型两次都没有返回合法 JSON。`);
      convo = [...convo, { role: 'assistant', content: text.slice(0, 2000) }, { role: 'user', content: '上一条不是合法 JSON。请只输出一个合法 JSON 对象。' }];
    }
  }
  throw new Error('unreachable');
}

/** 运行冻结在任务目录里的技能脚本（Python）。 */
export async function runSkillScript(ctx: Ctx, skill: string, script: string, args: string[], timeoutMs = 120_000) {
  const scriptPath = frozenSkillPath(ctx.root, skill, 'scripts', script);
  const r = await runControlled(ctx.python, ['-X', 'utf8', scriptPath, ...args], {
    cwd: path.dirname(scriptPath),
    timeoutMs,
    signal: ctx.signal,
    env: sandboxEnv(),
    logFile: P(ctx, 'logs', `${skill}-${script}.log`),
    tag: script
  });
  return { ok: r.exitCode === 0, output: `${r.stdout}\n${r.stderr}`.trim(), result: r };
}
