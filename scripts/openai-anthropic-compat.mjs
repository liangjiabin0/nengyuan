/** OpenAI Chat Completions ↔ Anthropic Messages。与 src/lib/openai-anthropic-compat.ts 保持同一套规则。 */

const ANTHROPIC_VERSION = '2023-06-01';

export function parseApiFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'anthropic' || raw === 'claude' || raw === 'messages') return 'anthropic';
  return 'openai';
}

export function anthropicAuthHeaders(apiKey) {
  const headers = { 'anthropic-version': ANTHROPIC_VERSION };
  const key = String(apiKey || '').trim();
  if (key) {
    headers['x-api-key'] = key;
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

export function anthropicEndpointUrl(baseUrl, kind) {
  let base = String(baseUrl || '').trim().replace(/\/$/, '');
  if (/^https?:\/\/api\.anthropic\.com$/i.test(base)) base = `${base}/v1`;
  base = base.replace(/\/compatible-mode\/v1$/i, '/apps/anthropic');
  if (base.endsWith('/messages')) base = base.slice(0, -'/messages'.length).replace(/\/$/, '');
  if (!base) return kind === 'messages' ? '/v1/messages' : '/v1/models';
  const root = /\/v1$/i.test(base) ? base : `${base}/v1`;
  return kind === 'messages' ? `${root}/messages` : `${root}/models`;
}

export function openaiEndpointUrl(baseUrl, kind) {
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
    // keep
  }
  return kind === 'chat' ? `${base}/chat/completions` : `${base}/models`;
}

export function isChatCompletionsPath(url) {
  return /\/chat\/completions\/?$/.test(String(url || '').split('?')[0]);
}

export function isModelsPath(url) {
  return /\/models\/?$/.test(String(url || '').split('?')[0]);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .join('\n');
}

function parseDataUrl(url) {
  const match = String(url || '').match(/^data:([^;]+);base64,(.+)$/i);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function isImageMediaType(value) {
  return String(value || '').toLowerCase().startsWith('image/');
}

function toAnthropicImage(part) {
  const type = String(part.type || '');
  const imageUrl = part.image_url && typeof part.image_url === 'object' ? part.image_url : null;
  const file = part.file && typeof part.file === 'object' ? part.file : part;
  const declaredMime = String(part.mime || part.media_type || file.media_type || '').toLowerCase();
  const url = String(imageUrl?.url || part.url || part.file_data || file.file_data || file.url || part.data || '');
  const parsed = parseDataUrl(url);
  if (parsed) {
    if (!isImageMediaType(parsed.mediaType)) return null;
    return { type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } };
  }
  const looksLikeImage = type === 'image_url' || type === 'image' || Boolean(imageUrl) || isImageMediaType(declaredMime);
  if (url && looksLikeImage) {
    return { type: 'image', source: { type: 'url', url } };
  }
  const raw = String(part.data || file.data || '');
  if (isImageMediaType(declaredMime) && raw) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: declaredMime, data: raw.replace(/^data:[^;]+;base64,/i, '') }
    };
  }
  return null;
}

function toUserContent(content) {
  if (typeof content === 'string' || content == null) return content || '';
  if (!Array.isArray(content)) return textOf(content);
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const type = String(part.type || '');
    if (type === 'image_url' || type === 'image' || type === 'file' || part.image_url) {
      const image = toAnthropicImage(part);
      if (image) blocks.push(image);
      continue;
    }
    if (type === 'text' || typeof part.text === 'string') {
      if (part.text) blocks.push({ type: 'text', text: String(part.text) });
    }
  }
  if (!blocks.length) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

function concatContent(left, right) {
  const toBlocks = (value) => {
    if (value == null || value === '') return [];
    if (typeof value === 'string') return [{ type: 'text', text: value }];
    return Array.isArray(value) ? value : [value];
  };
  const blocks = [...toBlocks(left), ...toBlocks(right)];
  if (!blocks.length) return '';
  if (blocks.every((block) => block && typeof block === 'object' && block.type === 'text')) {
    return blocks.map((block) => String(block.text || '')).join('\n');
  }
  return blocks;
}

function mapToolChoice(choice) {
  if (choice == null || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object') {
    const fn = choice.function && typeof choice.function === 'object' ? choice.function : choice;
    const name = String(fn.name || choice.name || '');
    if (name) return { type: 'tool', name };
  }
  return { type: 'auto' };
}

function mergeSameRole(messages) {
  const merged = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content = concatContent(last.content, message.content);
    else merged.push({ role: message.role, content: message.content });
  }
  if (merged[0]?.role === 'assistant') merged.unshift({ role: 'user', content: '请继续。' });
  if (!merged.length) merged.push({ role: 'user', content: 'ping' });
  return merged;
}

export function openaiChatToAnthropic(parsed, model) {
  const incoming = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const systemParts = [];
  const converted = [];
  for (const message of incoming) {
    const role = String(message?.role || '');
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
      const blocks = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call.function && typeof call.function === 'object' ? call.function : call;
        let input = {};
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

  const maxTokensRaw = Number(parsed?.max_tokens ?? parsed?.max_completion_tokens);
  let maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : 4096;
  const body = {
    model,
    max_tokens: maxTokens,
    messages: mergeSameRole(converted),
    stream: Boolean(parsed?.stream)
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (typeof parsed?.temperature === 'number') body.temperature = parsed.temperature;
  if (typeof parsed?.top_p === 'number') body.top_p = parsed.top_p;
  if (typeof parsed?.stop === 'string') body.stop_sequences = [parsed.stop];
  else if (Array.isArray(parsed?.stop)) body.stop_sequences = parsed.stop;

  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  if (tools.length) {
    body.tools = tools
      .map((tool) => {
        const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
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
  if (parsed?.tool_choice != null) body.tool_choice = mapToolChoice(parsed.tool_choice);

  const effort = String(parsed?.reasoning_effort || '').toLowerCase();
  const thinkingOn = effort === 'high'
    || effort === 'xhigh'
    || parsed?.chat_template_kwargs?.enable_thinking === true;
  if (thinkingOn) {
    const budget = effort === 'xhigh' ? 16000 : 8000;
    maxTokens = Math.max(maxTokens, budget + 1024);
    body.max_tokens = maxTokens;
    body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1) };
    body.temperature = 1;
  }
  return body;
}

function mapStopReason(reason) {
  const raw = String(reason || '');
  if (!raw) return null;
  if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop';
  if (raw === 'max_tokens') return 'length';
  if (raw === 'tool_use') return 'tool_calls';
  if (raw === 'refusal') return 'content_filter';
  return 'stop';
}

function extractAnthropicContent(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const texts = [];
  const thoughts = [];
  const toolCalls = [];
  for (const block of blocks) {
    const type = String(block?.type || '');
    if (type === 'text') texts.push(String(block.text || ''));
    else if (type === 'thinking') thoughts.push(String(block.thinking || block.text || ''));
    else if (type === 'tool_use') {
      toolCalls.push({
        id: String(block.id || ''),
        type: 'function',
        function: { name: String(block.name || ''), arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }
  return {
    content: texts.join('') || (toolCalls.length ? null : ''),
    reasoning: thoughts.join(''),
    toolCalls
  };
}

export function anthropicMessageToOpenAI(payload, model) {
  const extracted = extractAnthropicContent(payload);
  const usage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : {};
  const prompt = Number(usage.input_tokens || 0);
  const completion = Number(usage.output_tokens || 0);
  const message = { role: 'assistant', content: extracted.content };
  if (extracted.reasoning) message.reasoning_content = extracted.reasoning;
  if (extracted.toolCalls.length) message.tool_calls = extracted.toolCalls;
  return {
    id: String(payload?.id || `chatcmpl-${Date.now()}`),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(payload?.stop_reason) || 'stop'
    }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion
    }
  };
}

export function anthropicErrorToOpenAI(payload) {
  const rec = payload && typeof payload === 'object' ? payload : {};
  const nested = rec.error && typeof rec.error === 'object' ? rec.error : rec;
  return {
    error: {
      message: String(nested.message || rec.message || 'Anthropic 请求失败'),
      type: String(nested.type || rec.type || 'api_error'),
      code: nested.type || rec.type || null
    }
  };
}

function openaiChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

export class AnthropicSseToOpenAI {
  constructor(model, options = {}) {
    this.buffer = '';
    this.id = '';
    this.model = model;
    this.lockModel = options.lockModel === true;
    this.sentRole = false;
    this.toolIndex = -1;
    this.finished = false;
  }

  push(chunk) {
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

  flush() {
    let emitted = this.buffer.trim() ? this.handleEvent(this.buffer) : '';
    this.buffer = '';
    if (!this.finished) {
      emitted += this.line('[DONE]');
      this.finished = true;
    }
    return emitted;
  }

  line(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `data: ${data}\n\n`;
  }

  ensureId(value) {
    if (!this.id) this.id = String(value || `chatcmpl-${Date.now()}`);
    return this.id;
  }

  handleEvent(rawEvent) {
    const lines = rawEvent.split(/\r?\n/);
    let eventName = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return '';
    let payload;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return '';
    }
    const type = String(payload.type || eventName || '');
    if (type === 'message_start') {
      const message = payload.message && typeof payload.message === 'object' ? payload.message : {};
      this.ensureId(message.id || payload.id);
      if (!this.lockModel && typeof message.model === 'string' && message.model) this.model = message.model;
      if (this.sentRole) return '';
      this.sentRole = true;
      return this.line(openaiChunk(this.id, this.model, { role: 'assistant' }));
    }
    if (type === 'content_block_start') {
      const block = payload.content_block && typeof payload.content_block === 'object' ? payload.content_block : {};
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
      const delta = payload.delta && typeof payload.delta === 'object' ? payload.delta : {};
      const deltaType = String(delta.type || '');
      if (deltaType === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        return this.line(openaiChunk(this.ensureId(), this.model, { content: delta.text }));
      }
      if (deltaType === 'thinking_delta') {
        const thought = String(delta.thinking || delta.text || '');
        if (!thought) return '';
        return this.line(openaiChunk(this.ensureId(), this.model, {
          reasoning_content: thought
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
      const delta = payload.delta && typeof payload.delta === 'object' ? payload.delta : {};
      const finish = mapStopReason(delta.stop_reason);
      const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
      const chunk = openaiChunk(this.ensureId(), this.model, {}, finish);
      if (usage.output_tokens != null || usage.input_tokens != null) {
        const prompt = Number(usage.input_tokens || 0);
        const completion = Number(usage.output_tokens || 0);
        chunk.usage = {
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
