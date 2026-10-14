import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { getModelEndpoint } from '../config';
import { getPaperReviewModelConfig, type PaperReviewModelConfig, type PaperReviewThinking } from './model-config';

/** 一次模型调用的真实记录：请求的模型、上游实际回报的模型、档位、用量。 */
export type ModelUsageRecord = {
  stage: string;
  endpoint: 'paper-review' | 'storm-fallback';
  requestedModel: string;
  actualModel: string;
  thinking: PaperReviewThinking;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  durationMs: number;
  at: string;
};

export type ProbeResult = {
  ok: boolean;
  /** 上游 /v1/models 是否列出首选模型 */
  listed: boolean;
  /** 实际发一次请求是否成功 */
  responded: boolean;
  actualModel?: string;
  /** 首选思考档位是否被接受 */
  thinkingAccepted: boolean;
  availableModels: string[];
  reason?: string;
  checkedAt: string;
};

export class PaperReviewModelError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'PaperReviewModelError';
  }
}

type ResolvedEndpoint = {
  kind: 'paper-review' | 'storm-fallback';
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking: PaperReviewThinking;
};

function v1(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1${suffix}`;
}

/**
 * 论文智能评审专用的 fetch：配置了代理（页面里的“代理地址”或 PAPER_REVIEW_PROXY）时经代理发出，否则直连。
 * 只影响论文智能评审的模型请求，不改变系统其它功能的网络行为。
 */
let proxyDispatcher: { url: string; agent: Dispatcher } | null = null;
function dispatcherFor(): Dispatcher | undefined {
  const proxy = getPaperReviewModelConfig().proxyUrl;
  if (!proxy) return undefined;
  if (proxyDispatcher?.url !== proxy) proxyDispatcher = { url: proxy, agent: new ProxyAgent({ uri: proxy }) };
  return proxyDispatcher.agent;
}

function pfetch(url: string, init: RequestInit) {
  const dispatcher = dispatcherFor();
  return undiciFetch(url, { ...(init as object), ...(dispatcher ? { dispatcher } : {}) } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await pfetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const retryAfterSec = Number(response.headers.get('retry-after')) || 0;
  return { status: response.status, body, text, retryAfterSec };
}

function errorText(body: unknown, text: string) {
  const err = (body as { error?: { message?: string } | string } | null)?.error;
  return (typeof err === 'string' ? err : err?.message) || text.slice(0, 300);
}

/** 运行前探测：列出上游模型、确认首选模型能真实应答、确认思考档位被接受。不消耗多少 token。 */
export async function probePaperReviewModel(config: PaperReviewModelConfig = getPaperReviewModelConfig()): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const base: ProbeResult = { ok: false, listed: false, responded: false, thinkingAccepted: false, availableModels: [], checkedAt };
  if (!config.baseUrl) return { ...base, reason: '未配置论文智能评审的接口地址。' };
  if (!config.apiKey) return { ...base, reason: '未配置论文智能评审的 API Key。' };
  const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  try {
    const models = await fetchJson(v1(config.baseUrl, '/models'), { headers }, 30_000);
    if (models.status === 401 || models.status === 403) return { ...base, reason: `API Key 无效或无权限（HTTP ${models.status}）。` };
    const ids = ((models.body as { data?: Array<{ id?: string }> } | null)?.data || []).map((m) => String(m.id || '')).filter(Boolean);
    base.availableModels = ids;
    base.listed = ids.includes(config.model);
    const chat = await fetchJson(v1(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        ...(config.thinking !== 'none' ? { reasoning_effort: config.thinking } : {}),
        max_completion_tokens: 2000
      })
    }, 120_000);
    if (chat.status !== 200) {
      const msg = errorText(chat.body, chat.text);
      const thinkingRejected = /reasoning|effort/i.test(msg);
      return {
        ...base,
        responded: false,
        reason: thinkingRejected
          ? `模型 ${config.model} 不接受思考档位 ${config.thinking}：${msg}`
          : `模型 ${config.model} 调用失败（HTTP ${chat.status}）：${msg}`
      };
    }
    const actualModel = String((chat.body as { model?: string } | null)?.model || '');
    return {
      ...base,
      ok: true,
      responded: true,
      thinkingAccepted: true,
      actualModel,
      reason: base.listed ? undefined : `上游模型列表里没有 ${config.model}，但调用成功（实际返回 ${actualModel || '未知'}）。`
    };
  } catch (error) {
    return { ...base, reason: `无法连接论文智能评审接口：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 解析这次任务实际要用的端点。
 * 首选模型探测失败时：只有在任务选项里明确允许回退，才用系统 Storm 档；否则抛错，绝不静默替换。
 */
export function resolvePaperReviewEndpoint(probe: ProbeResult, options: { allowStormFallback: boolean }): ResolvedEndpoint {
  const config = getPaperReviewModelConfig();
  if (probe.ok) {
    return { kind: 'paper-review', baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, thinking: config.thinking };
  }
  if (!options.allowStormFallback) {
    throw new PaperReviewModelError(`首选模型不可用：${probe.reason || '未知原因'}。请修改模型配置，或在任务设置里允许回退到 Storm。`);
  }
  const storm = getModelEndpoint('storm');
  if (!storm.baseUrl || !storm.apiKey) throw new PaperReviewModelError('首选模型不可用，且系统 Storm 档也未配置。');
  return { kind: 'storm-fallback', baseUrl: storm.baseUrl, apiKey: storm.apiKey, model: storm.model, thinking: 'high' };
}

/** 读取 OpenAI 兼容的 SSE 流，拼接正文，取最后一个 chunk 里的 usage。 */
async function streamChat(url: string, apiKey: string, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await pfetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  const retryAfterSec = Number(response.headers.get('retry-after')) || 0;
  if (response.status !== 200 || !response.body) {
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: response.status, text: '', model: '', promptTokens: 0, completionTokens: 0, reasoningTokens: 0, errorText: errorText(parsed, text), retryAfterSec };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let model = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as { model?: string; choices?: Array<{ delta?: { content?: string } }>; usage?: typeof usage; error?: { message?: string } };
        if (chunk.error) throw new Error(chunk.error.message || '模型流式输出报错');
        if (chunk.model) model = chunk.model;
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) text += piece;
        if (chunk.usage) usage = chunk.usage;
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }
  return {
    status: 200,
    text,
    model,
    promptTokens: Number(usage.prompt_tokens || 0),
    completionTokens: Number(usage.completion_tokens || 0),
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0),
    errorText: '',
    retryAfterSec
  };
}

export type ChatContentPart ={ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] };

/** 调用模型并返回文本与真实用量记录。可取消；超时可配置；对 429/5xx 有限次重试。 */
export async function callPaperReviewModel(
  endpoint: ResolvedEndpoint,
  messages: ChatMessage[],
  opts: { stage: string; signal?: AbortSignal; timeoutMs?: number; maxTokens?: number; json?: boolean; thinking?: PaperReviewThinking }
): Promise<{ text: string; usage: ModelUsageRecord }> {
  const started = Date.now();
  const thinking = opts.thinking ?? endpoint.thinking;
  // 必须用流式：上游代理在 120 秒内没有任何数据就会断开连接，而高思考档位的长任务常常要 2 分钟以上才开始输出。
  const body = {
    model: endpoint.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(thinking !== 'none' ? { reasoning_effort: thinking } : {}),
    ...(opts.maxTokens ? { max_completion_tokens: opts.maxTokens } : {}),
    ...(opts.json ? { response_format: { type: 'json_object' } } : {})
  };
  // 429 / 5xx：最多 3 次请求；连接中断（代理或上游断开）：最多 4 次。有 Retry-After 时按它等待，否则 5s、10s、15s 递增；仍失败就报错停止，不无限重试。
  let lastError = '';
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (opts.signal?.aborted) throw new DOMException('任务已取消', 'AbortError');
    let res: Awaited<ReturnType<typeof streamChat>>;
    try {
      res = await streamChat(v1(endpoint.baseUrl, '/chat/completions'), endpoint.apiKey, body, opts.timeoutMs ?? 30 * 60_000, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      lastError = `连接中断：${error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause?.code || error.message : String(error)}`;
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      continue;
    }
    if (res.status === 200) {
      if (!res.text.trim()) throw new PaperReviewModelError(`模型 ${endpoint.model} 返回了空内容。`, true);
      return {
        text: res.text,
        usage: {
          stage: opts.stage,
          endpoint: endpoint.kind,
          requestedModel: endpoint.model,
          actualModel: res.model,
          thinking,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          reasoningTokens: res.reasoningTokens,
          durationMs: Date.now() - started,
          at: new Date().toISOString()
        }
      };
    }
    lastError = `HTTP ${res.status}：${res.errorText}`;
    if ((res.status !== 429 && res.status < 500) || attempt >= 3) break;
    const waitMs = res.retryAfterSec > 0 ? res.retryAfterSec * 1000 : 5_000 * attempt;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5 * 60_000)));
  }
  throw new PaperReviewModelError(`模型 ${endpoint.model} 调用失败：${lastError}`, true);
}
