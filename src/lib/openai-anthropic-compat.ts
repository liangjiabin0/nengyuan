/** OpenAI Chat Completions ↔ Anthropic Messages 互转，供设置页直连与 Gateway 共用同一套规则。 */

export type ApiFormat = 'openai' | 'anthropic';

const ANTHROPIC_VERSION = '2023-06-01';

export function parseApiFormat(value: unknown): ApiFormat {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'anthropic' || raw === 'claude' || raw === 'messages') return 'anthropic';
  return 'openai';
}

export function anthropicAuthHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION
  };
  const key = String(apiKey || '').trim();
  if (key) {
    headers['x-api-key'] = key;
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

export function anthropicEndpointUrl(baseUrl: string, kind: 'messages' | 'models'): string {
  let base = String(baseUrl || '').trim().replace(/\/$/, '');
  if (/^https?:\/\/api\.anthropic\.com$/i.test(base)) {
    base = `${base}/v1`;
  }
  // 阿里云 OpenAI 兼容地址不能直接改格式；Anthropic 走 /apps/anthropic/v1/messages
  base = base.replace(/\/compatible-mode\/v1$/i, '/apps/anthropic');
  if (base.endsWith('/messages')) {
    base = base.slice(0, -'/messages'.length).replace(/\/$/, '');
  }
  if (!base) return kind === 'messages' ? '/v1/messages' : '/v1/models';
  const root = /\/v1$/i.test(base) ? base : `${base}/v1`;
  return kind === 'messages' ? `${root}/messages` : `${root}/models`;
}

/** 只填了主机名的 Base URL（如 https://uuapi.io）自动补 /v1，避免打到 /chat/completions 而不是 /v1/chat/completions。 */
export function openaiEndpointUrl(baseUrl: string, kind: 'chat' | 'models'): string {
  let base = String(baseUrl || '').trim().replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) {
    base = base.slice(0, -'/chat/completions'.length).replace(/\/$/, '');
  }
  if (!base) return kind === 'chat' ? '/v1/chat/completions' : '/v1/models';
  try {
    const parsed = new URL(base);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      base = `${parsed.origin}/v1`;
    }
  } catch {
    // 相对路径保持原样
  }
  return kind === 'chat' ? `${base}/chat/completions` : `${base}/models`;
}

export function aliyunAnthropicBaseUrl(baseUrl: string): string | null {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  if (/\/compatible-mode\/v1$/i.test(base)) {
    return base.replace(/\/compatible-mode\/v1$/i, '/apps/anthropic');
  }
  if (/\/apps\/anthropic(?:\/v1)?$/i.test(base)) return base.replace(/\/v1$/i, '');
  return null;
}

export function aliyunOpenAIBaseUrl(baseUrl: string): string | null {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  if (/\/apps\/anthropic(?:\/v1)?$/i.test(base)) {
    return base.replace(/\/apps\/anthropic(?:\/v1)?$/i, '/compatible-mode/v1');
  }
  return null;
}

export function describeLlmHttpError(status: number, text: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const nested = parsed?.error && typeof parsed.error === 'object'
    ? parsed.error as Record<string, unknown>
    : parsed || {};
  const code = String(nested.code || nested.type || parsed?.code || '');
  const message = String(nested.message || parsed?.message || text.replace(/\s+/g, ' ').trim().slice(0, 180));
  if (/Unpurchased/i.test(code) || /Access to model denied/i.test(message)) {
    return '模型未开通或当前 Key 无权调用（AccessDenied.Unpurchased）。请在阿里云百炼开通该模型，或改用已开通的模型名。';
  }
  if (status === 404) {
    const looksAliyun = /aliyuncs|compatible-mode|apps\/anthropic|Unpurchased/i.test(`${text} ${message}`);
    if (looksAliyun) {
      return 'Anthropic 接口地址不正确（HTTP 404）。阿里云请填业务空间的 /apps/anthropic，不要用 /compatible-mode/v1。';
    }
    return `接口不存在（HTTP 404）。请确认 Base URL 是否包含 /v1，以及接口格式是否选对（OpenAI 走 /chat/completions，Anthropic 走 /v1/messages）。${message ? ` ${message.slice(0, 120)}` : ''}`;
  }
  if (status === 401 || status === 403) {
    return `鉴权失败 HTTP ${status}${message ? `：${message.slice(0, 140)}` : ''}`;
  }
  return `HTTP ${status}${message ? `: ${message.slice(0, 160)}` : ''}`;
}

export function isChatCompletionsPath(url: string): boolean {
  const pathOnly = String(url || '').split('?')[0];
  return /\/chat\/completions\/?$/.test(pathOnly);
}

export function isModelsPath(url: string): boolean {
  const pathOnly = String(url || '').split('?')[0];
  return /\/models\/?$/.test(pathOnly);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const rec = part as Record<string, unknown>;
      if (typeof rec.text === 'string') return rec.text;
      if (typeof rec.content === 'string') return rec.content;
      return '';
    })
    .join('\n');
}

function parseDataUrl(url: string) {
  const match = String(url || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function isImageMediaType(value: string) {
  return String(value || '').toLowerCase().startsWith('image/');
}

function toAnthropicImage(rec: Record<string, unknown>) {
  const type = String(rec.type || '');
  const imageUrl = rec.image_url && typeof rec.image_url === 'object'
    ? rec.image_url as Record<string, unknown>
    : null;
  const file = rec.file && typeof rec.file === 'object'
    ? rec.file as Record<string, unknown>
    : rec;
  const declaredMime = String(rec.mime || rec.media_type || file.media_type || '').toLowerCase();
  const url = String(
    imageUrl?.url
    || rec.url
    || rec.file_data
    || file.file_data
    || file.url
    || rec.data
    || ''
  );
  const parsed = parseDataUrl(url);
  if (parsed) {
    if (!isImageMediaType(parsed.mediaType)) return null;
    return {
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
    };
  }
  const looksLikeImage = type === 'image_url' || type === 'image' || Boolean(imageUrl) || isImageMediaType(declaredMime);
  if (url && looksLikeImage) {
    return { type: 'image', source: { type: 'url', url } };
  }
  const raw = String(rec.data || file.data || '');
  if (isImageMediaType(declaredMime) && raw) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: declaredMime, data: raw.replace(/^data:[^;]+;base64,/i, '') }
    };
  }
  return null;
}

function toUserContent(content: unknown): unknown {
  if (typeof content === 'string' || content == null) return content || '';
  if (!Array.isArray(content)) return textOf(content);
  const blocks: unknown[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const rec = part as Record<string, unknown>;
    const type = String(rec.type || '');
    if (type === 'image_url' || type === 'image' || type === 'file' || rec.image_url) {
      const image = toAnthropicImage(rec);
      if (image) blocks.push(image);
      continue;
    }
    if (type === 'text' || typeof rec.text === 'string') {
      const text = String(rec.text || '');
      if (text) blocks.push({ type: 'text', text });
    }
  }
  if (!blocks.length) return '';
  if (blocks.length === 1 && (blocks[0] as { type?: string }).type === 'text') {
    return (blocks[0] as { text: string }).text;
  }
  return blocks;
}

function concatContent(left: unknown, right: unknown): unknown {
  const toBlocks = (value: unknown): unknown[] => {
    if (value == null || value === '') return [];
    if (typeof value === 'string') return [{ type: 'text', text: value }];
    if (Array.isArray(value)) return value;
    return [value];
  };
  const blocks = [...toBlocks(left), ...toBlocks(right)];
  if (!blocks.length) return '';
  if (blocks.every((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'text')) {
    return blocks.map((block) => String((block as { text?: string }).text || '')).join('\n');
  }
  return blocks;
}

function mapToolChoice(choice: unknown): unknown {
  if (choice == null || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object') {
    const rec = choice as Record<string, unknown>;
    const fn = rec.function && typeof rec.function === 'object'
      ? rec.function as Record<string, unknown>
      : rec;
    const name = String(fn.name || rec.name || '');
    if (name) return { type: 'tool', name };
  }
  return { type: 'auto' };
}

function mergeSameRole(messages: Array<{ role: string; content: unknown }>) {
  const merged: Array<{ role: string; content: unknown }> = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content = concatContent(last.content, message.content);
    } else {
      merged.push({ role: message.role, content: message.content });
    }
  }
  if (merged[0]?.role === 'assistant') {
    merged.unshift({ role: 'user', content: '请继续。' });
  }
  if (!merged.length) {
    merged.push({ role: 'user', content: 'ping' });
  }
  return merged;
}

export function openaiChatToAnthropic(
  parsed: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const incoming = Array.isArray(parsed.messages) ? parsed.messages as Array<Record<string, unknown>> : [];
  const systemParts: string[] = [];
  const converted: Array<{ role: string; content: unknown }> = [];

  for (const message of incoming) {
    const role = String(message.role || '');
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content);
      if (text.trim()) systemParts.push(text);
      continue;
    }
    if (role === 'tool') {
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(message.tool_call_id || message.id || ''),
          content: textOf(message.content)
        }]
      });
      continue;
    }
    if (role === 'assistant') {
      const blocks: unknown[] = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: 'text', text });
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
      for (const call of toolCalls) {
        const fn = call.function && typeof call.function === 'object'
          ? call.function as Record<string, unknown>
          : call;
        let input: unknown = {};
        try {
          input = JSON.parse(String(fn.arguments || '{}'));
        } catch {
          input = { raw: String(fn.arguments || '') };
        }
        blocks.push({
          type: 'tool_use',
          id: String(call.id || ''),
          name: String(fn.name || ''),
          input
        });
      }
      converted.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      continue;
    }
    converted.push({ role: 'user', content: toUserContent(message.content) });
  }

  const maxTokensRaw = Number(parsed.max_tokens ?? parsed.max_completion_tokens);
  let maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : 4096;
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: mergeSameRole(converted),
    stream: Boolean(parsed.stream)
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (typeof parsed.temperature === 'number') body.temperature = parsed.temperature;
  if (typeof parsed.top_p === 'number') body.top_p = parsed.top_p;
  if (typeof parsed.stop === 'string') body.stop_sequences = [parsed.stop];
  else if (Array.isArray(parsed.stop)) body.stop_sequences = parsed.stop;

  const tools = Array.isArray(parsed.tools) ? parsed.tools as Array<Record<string, unknown>> : [];
  if (tools.length) {
    body.tools = tools
      .map((tool) => {
        const fn = tool.function && typeof tool.function === 'object'
          ? tool.function as Record<string, unknown>
          : tool;
        const name = String(fn.name || tool.name || '');
        if (!name) return null;
        return {
          name,
          description: String(fn.description || tool.description || ''),
          input_schema: fn.parameters || tool.input_schema || { type: 'object', properties: {} }
        };
      })
      .filter(Boolean);
  }
  if (parsed.tool_choice != null) body.tool_choice = mapToolChoice(parsed.tool_choice);

  const effort = String(parsed.reasoning_effort || '').toLowerCase();
  const thinkingOn = effort === 'high'
    || effort === 'xhigh'
    || (parsed.chat_template_kwargs as { enable_thinking?: unknown } | undefined)?.enable_thinking === true;
  if (thinkingOn) {
    const budget = effort === 'xhigh' ? 16_000 : 8_000;
    maxTokens = Math.max(maxTokens, budget + 1024);
    body.max_tokens = maxTokens;
    body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1) };
    body.temperature = 1;
  }
  return body;
}

function mapStopReason(reason: unknown): string | null {
  const raw = String(reason || '');
  if (!raw) return null;
  if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop';
  if (raw === 'max_tokens') return 'length';
  if (raw === 'tool_use') return 'tool_calls';
  if (raw === 'refusal') return 'content_filter';
  return 'stop';
}

function extractAnthropicContent(payload: Record<string, unknown>) {
  const blocks = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : [];
  const texts: string[] = [];
  const thoughts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];
  for (const block of blocks) {
    const type = String(block.type || '');
    if (type === 'text') texts.push(String(block.text || ''));
    else if (type === 'thinking') thoughts.push(String(block.thinking || block.text || ''));
    else if (type === 'tool_use') {
      toolCalls.push({
        id: String(block.id || ''),
        type: 'function',
        function: {
          name: String(block.name || ''),
          arguments: JSON.stringify(block.input ?? {})
        }
      });
    }
  }
  return {
    content: texts.join('') || (toolCalls.length ? null : ''),
    reasoning: thoughts.join(''),
    toolCalls
  };
}

export function anthropicMessageToOpenAI(payload: Record<string, unknown>, model: string) {
  const extracted = extractAnthropicContent(payload);
  const usage = payload.usage && typeof payload.usage === 'object'
    ? payload.usage as Record<string, unknown>
    : {};
  const prompt = Number(usage.input_tokens || 0);
  const completion = Number(usage.output_tokens || 0);
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: extracted.content
  };
  if (extracted.reasoning) message.reasoning_content = extracted.reasoning;
  if (extracted.toolCalls.length) message.tool_calls = extracted.toolCalls;
  return {
    id: String(payload.id || `chatcmpl-${Date.now()}`),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(payload.stop_reason) || 'stop'
    }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion
    }
  };
}

export function anthropicErrorToOpenAI(payload: unknown) {
  const rec = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const nested = rec.error && typeof rec.error === 'object' ? rec.error as Record<string, unknown> : rec;
  const message = String(nested.message || rec.message || 'Anthropic 请求失败');
  return {
    error: {
      message,
      type: String(nested.type || rec.type || 'api_error'),
      code: nested.type || rec.type || null
    }
  };
}

function openaiChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

export class AnthropicSseToOpenAI {
  private buffer = '';
  private id = '';
  private model: string;
  private lockModel = false;
  private sentRole = false;
  private toolIndex = -1;
  private finished = false;

  constructor(model: string, options?: { lockModel?: boolean }) {
    this.model = model;
    this.lockModel = options?.lockModel === true;
  }

  push(chunk: string): string {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let emitted = '';
    let sep = this.buffer.indexOf('\n\n');
    while (sep >= 0) {
      const rawEvent = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      emitted += this.handleEvent(rawEvent);
      sep = this.buffer.indexOf('\n\n');
    }
    return emitted;
  }

  flush(): string {
    let emitted = this.buffer.trim() ? this.handleEvent(this.buffer) : '';
    this.buffer = '';
    if (!this.finished) {
      emitted += this.line('[DONE]');
      this.finished = true;
    }
    return emitted;
  }

  private line(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `data: ${data}\n\n`;
  }

  private ensureId(value?: unknown) {
    if (!this.id) this.id = String(value || `chatcmpl-${Date.now()}`);
    return this.id;
  }

  private handleEvent(rawEvent: string): string {
    const lines = rawEvent.split(/\r?\n/);
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return '';
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    } catch {
      return '';
    }
    const type = String(payload.type || eventName || '');
    if (type === 'message_start') {
      const message = payload.message && typeof payload.message === 'object'
        ? payload.message as Record<string, unknown>
        : {};
      this.ensureId(message.id || payload.id);
      if (!this.lockModel && typeof message.model === 'string' && message.model) this.model = message.model;
      if (this.sentRole) return '';
      this.sentRole = true;
      return this.line(openaiChunk(this.id, this.model, { role: 'assistant' }));
    }
    if (type === 'content_block_start') {
      const block = payload.content_block && typeof payload.content_block === 'object'
        ? payload.content_block as Record<string, unknown>
        : {};
      if (String(block.type || '') !== 'tool_use') return '';
      this.toolIndex += 1;
      return this.line(openaiChunk(this.ensureId(), this.model, {
        tool_calls: [{
          index: this.toolIndex,
          id: String(block.id || ''),
          type: 'function',
          function: { name: String(block.name || ''), arguments: '' }
        }]
      }));
    }
    if (type === 'content_block_delta') {
      const delta = payload.delta && typeof payload.delta === 'object'
        ? payload.delta as Record<string, unknown>
        : {};
      const deltaType = String(delta.type || '');
      if (deltaType === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        return this.line(openaiChunk(this.ensureId(), this.model, { content: delta.text }));
      }
      if (deltaType === 'thinking_delta') {
        const thought = String(delta.thinking || delta.text || '');
        if (!thought) return '';
        return this.line(openaiChunk(this.ensureId(), this.model, {
          reasoning_content: thought,
          reasoning: thought
        }));
      }
      if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
        return this.line(openaiChunk(this.ensureId(), this.model, {
          tool_calls: [{
            index: Math.max(0, this.toolIndex),
            function: { arguments: delta.partial_json }
          }]
        }));
      }
      return '';
    }
    if (type === 'message_delta') {
      const delta = payload.delta && typeof payload.delta === 'object'
        ? payload.delta as Record<string, unknown>
        : {};
      const finish = mapStopReason(delta.stop_reason);
      const usage = payload.usage && typeof payload.usage === 'object'
        ? payload.usage as Record<string, unknown>
        : {};
      const chunk = openaiChunk(this.ensureId(), this.model, {}, finish);
      if (usage && (usage.output_tokens != null || usage.input_tokens != null)) {
        const prompt = Number(usage.input_tokens || 0);
        const completion = Number(usage.output_tokens || 0);
        (chunk as { usage?: unknown }).usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion
        };
      }
      return this.line(chunk);
    }
    if (type === 'message_stop') {
      this.finished = true;
      return this.line('[DONE]');
    }
    return '';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

export async function fetchChatCompletions(
  settings: { baseUrl: string; model: string; apiKey: string; apiFormat?: ApiFormat },
  openaiBody: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<Response> {
  const format = parseApiFormat(settings.apiFormat);
  const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
  const model = String(openaiBody.model || settings.model || '');
  const body = { ...openaiBody, model };
  if (format !== 'anthropic') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    return fetch(openaiEndpointUrl(baseUrl, 'chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal
    });
  }

  const anthropicBody = openaiChatToAnthropic(body, model);
  const response = await fetch(anthropicEndpointUrl(baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...anthropicAuthHeaders(settings.apiKey)
    },
    body: JSON.stringify(anthropicBody),
    signal: options?.signal
  });

  if (anthropicBody.stream) {
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      return new Response(JSON.stringify(anthropicErrorToOpenAI(safeJson(text))), {
        status: response.status || 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const transformer = new AnthropicSseToOpenAI(model);
    const source = response.body;
    return new Response(
      new ReadableStream({
        async start(controller) {
          const reader = source.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const out = transformer.push(decoder.decode(value, { stream: true }));
              if (out) controller.enqueue(encoder.encode(out));
            }
            const tail = transformer.flush();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
      }
    );
  }

  const text = await response.text();
  if (!response.ok) {
    return new Response(JSON.stringify(anthropicErrorToOpenAI(safeJson(text))), {
      status: response.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
  const parsed = safeJson(text);
  const openai = anthropicMessageToOpenAI(
    parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {},
    model
  );
  return new Response(JSON.stringify(openai), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export async function fetchModelsList(
  settings: { baseUrl: string; apiKey: string; apiFormat?: ApiFormat },
  options?: { signal?: AbortSignal }
): Promise<Response> {
  const format = parseApiFormat(settings.apiFormat);
  const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
  if (format !== 'anthropic') {
    const headers: Record<string, string> = {};
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    return fetch(openaiEndpointUrl(baseUrl, 'models'), { method: 'GET', headers, signal: options?.signal });
  }
  return fetch(anthropicEndpointUrl(baseUrl, 'models'), {
    method: 'GET',
    headers: anthropicAuthHeaders(settings.apiKey),
    signal: options?.signal
  });
}
