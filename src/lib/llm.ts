import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getModelSettings, type ModelEndpointSettings } from './config';
import {
  getLocalSmallChatExtras,
  isLocalSmallThinkingOn,
  LOCAL_SMALL_THINKING_MAX_TOKENS
} from './local-llm-extras';
import { fetchChatCompletions, parseApiFormat, describeLlmHttpError } from './openai-anthropic-compat';

const LLM_TIMEOUT_MS = 120_000;
const LLM_MAX_ATTEMPTS = 3;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * OpenAI 兼容请求的思考 / 采样参数。
 * - 本地小模型（Arc）：关思考用 enable_thinking=false，开思考用 medium / xhigh。禁止 reasoning_effort=none。
 * - 云端大模型：仅在明确开思考时带 reasoning_effort:"high"。连通性测试（短补全）不带，避免中转网关 400。
 */
export function getChatRequestExtras(
  settings = getModelSettings(),
  options?: { thinking?: boolean; maxTokens?: number }
) {
  const shortCompletion = options?.maxTokens != null && options.maxTokens < 256;
  if (parseApiFormat(settings.apiFormat) === 'anthropic') {
    const thinking = shortCompletion ? false : options?.thinking ?? settings.think === true;
    return thinking ? { reasoning_effort: 'high' as const } : {};
  }
  if (settings.reasoningEffortNone === false) {
    if (shortCompletion || options?.thinking === false) return {};
    const thinking = options?.thinking ?? settings.think === true;
    return thinking ? { reasoning_effort: 'high' as const } : {};
  }
  const thinking = shortCompletion ? false : options?.thinking ?? settings.think === true;
  return getLocalSmallChatExtras(thinking ? 'xhigh' : 'off');
}

export function getLLM(settings = getModelSettings()) {
  return new OpenAI({
    apiKey: settings.apiKey || 'not-required',
    baseURL: settings.baseUrl,
    maxRetries: 1,
    timeout: LLM_TIMEOUT_MS
  });
}

/** 部分兼容网关（如 Packy）在 stream:false 时仍返回 SSE，需手动拼接 delta。 */
export function parseSseCompletionBody(text: string): string {
  let content = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) content += delta;
      const message = chunk.choices?.[0]?.message?.content;
      if (message) content += message;
    } catch {
      // 跳过畸形 SSE 行
    }
  }
  return content;
}

export type ChatCompletionResult = {
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

/** 非流式补全：兼容 JSON 与误标为 SSE 的网关响应。 */
function extractMessageContent(message: {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
} | undefined) {
  if (!message) return '';
  const raw = message.content;
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw)) {
    const joined = raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text || '');
        }
        return '';
      })
      .join('');
    if (joined.trim()) return joined;
  }
  for (const key of ['reasoning_content', 'reasoning'] as const) {
    const value = message[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return typeof raw === 'string' ? raw : '';
}

export async function completeChat(
  messages: ChatCompletionMessageParam[],
  options: {
    max_tokens?: number;
    model?: string;
    temperature?: number;
    thinking?: boolean;
    settings?: ModelEndpointSettings;
    signal?: AbortSignal;
    maxAttempts?: number;
  } = {}
): Promise<ChatCompletionResult> {
  const settings = options.settings || getModelSettings();
  const model = options.model ?? settings.model;
  const extras = getChatRequestExtras(settings, {
    thinking: options.thinking,
    maxTokens: options.max_tokens
  });
  const openaiBody = {
    model,
    messages,
    stream: false,
    ...extras,
    max_tokens: options.max_tokens ?? (isLocalSmallThinkingOn(extras) ? LOCAL_SMALL_THINKING_MAX_TOKENS : 1024),
    ...(options.temperature != null ? { temperature: options.temperature } : {})
  };
  let response: Response | undefined;
  let lastError: unknown;
  const attempts = Math.max(1, options.maxAttempts ?? LLM_MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetchChatCompletions(settings, openaiBody, {
        signal: options.signal || AbortSignal.timeout(LLM_TIMEOUT_MS)
      });
      if (response.ok || response.status < 500 || attempt === attempts) break;
      await response.body?.cancel().catch(() => undefined);
      await wait(600 * attempt);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt === attempts) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`模型服务连接失败（已重试 ${attempt} 次）：${detail}`);
      }
      await wait(600 * attempt);
    }
  }
  if (!response) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError || '未知错误');
    throw new Error(`模型服务无响应：${detail}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(describeLlmHttpError(response.status, text));
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as {
        choices?: Array<{
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            reasoning?: unknown;
          };
        }>;
        usage?: ChatCompletionResult['usage'];
      };
      return {
        content: extractMessageContent(json.choices?.[0]?.message),
        usage: json.usage
      };
    } catch {
      // 非标准 JSON，继续尝试 SSE 解析
    }
  }

  if (trimmed.startsWith('data:')) {
    return { content: parseSseCompletionBody(text) };
  }

  throw new Error(`无法解析 LLM 响应: ${trimmed.slice(0, 200)}`);
}

function compactThought(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function takeReasoningDelta(delta: {
  reasoning_content?: unknown;
  reasoning?: unknown;
} | undefined) {
  if (!delta) return '';
  for (const key of ['reasoning_content', 'reasoning'] as const) {
    const value = delta[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function takeContentDelta(delta: { content?: unknown } | undefined) {
  if (!delta) return '';
  const raw = delta.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text || '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function stripThinkTags(content: string) {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** 流式补全：思考与正文分开回调，对话页只展示一行滚动思维链。 */
export async function streamChat(
  messages: ChatCompletionMessageParam[],
  options: {
    max_tokens?: number;
    model?: string;
    temperature?: number;
    thinking?: boolean;
    settings?: ModelEndpointSettings;
    signal?: AbortSignal;
    onThought?: (text: string) => void;
    onDelta?: (text: string) => void;
  } = {}
): Promise<ChatCompletionResult> {
  const settings = options.settings || getModelSettings();
  const model = options.model ?? settings.model;
  const extras = getChatRequestExtras(settings, {
    thinking: options.thinking,
    maxTokens: options.max_tokens
  });

  const response = await fetchChatCompletions(settings, {
    model,
    messages,
    stream: true,
    ...extras,
    max_tokens: options.max_tokens ?? (isLocalSmallThinkingOn(extras) ? LOCAL_SMALL_THINKING_MAX_TOKENS : 1024),
    ...(options.temperature != null ? { temperature: options.temperature } : {})
  }, { signal: options.signal || AbortSignal.timeout(LLM_TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  if (!response.body) {
    const fallback = await completeChat(messages, options);
    if (fallback.content) options.onDelta?.(fallback.content);
    return fallback;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let thinkOpen = false;
  let usage: ChatCompletionResult['usage'];

  const publishThought = () => {
    const line = compactThought(reasoning);
    if (line) options.onThought?.(line);
  };

  const ingestContent = (chunk: string) => {
    if (!chunk) return;
    let rest = chunk;
    while (rest) {
      if (thinkOpen) {
        const close = rest.toLowerCase().indexOf('</think>');
        if (close < 0) {
          reasoning += rest;
          publishThought();
          return;
        }
        reasoning += rest.slice(0, close);
        rest = rest.slice(close + 8);
        thinkOpen = false;
        publishThought();
        continue;
      }
      const open = rest.toLowerCase().indexOf('<think>');
      if (open < 0) {
        content += rest;
        options.onDelta?.(content);
        return;
      }
      if (open > 0) {
        content += rest.slice(0, open);
        options.onDelta?.(content);
      }
      rest = rest.slice(open + 7);
      thinkOpen = true;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
            message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
          }>;
          usage?: ChatCompletionResult['usage'];
        };
        const delta = chunk.choices?.[0]?.delta;
        const message = chunk.choices?.[0]?.message;
        const thought = takeReasoningDelta(delta) || takeReasoningDelta(message);
        if (thought) {
          reasoning += thought;
          publishThought();
        }
        ingestContent(takeContentDelta(delta) || takeContentDelta(message));
        if (chunk.usage) usage = chunk.usage;
      } catch {
        // skip malformed SSE
      }
    }
  }

  const finalContent = stripThinkTags(content);
  if (finalContent) options.onDelta?.(finalContent);
  return { content: finalContent, usage };
}

export async function testLLMConnection(settings = getModelSettings()) {
  const { content } = await completeChat(
    [{ role: 'user', content: '请用中文回复“连接正常”。' }],
    {
      max_tokens: 64,
      model: settings.model,
      settings,
      thinking: false,
      maxAttempts: 1,
      signal: AbortSignal.timeout(45_000)
    }
  );
  return content || '连接正常';
}
