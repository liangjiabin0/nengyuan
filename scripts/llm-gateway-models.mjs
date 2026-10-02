/**
 * LLM Gateway 对内模型身份。上游真实名只用于转发，不出现在 /v1/models 与响应体。
 */

export const SMALL_PUBLIC_MODEL = 'arc';
export const LARGE_PUBLIC_MODEL = 'thunder';
export const STORM_PUBLIC_MODEL = 'storm';
export const IMAGE_PUBLIC_MODEL = 'ai4es-image';

export const SMALL_LEGACY_ALIAS = 'ai4es-small';
export const LARGE_LEGACY_ALIAS = 'ai4es-large';

export const LEGACY_SMALL_THINKING_ALIASES = new Set([
  'ai4es-small-low',
  'ai4es-small-medium',
  'ai4es-small-xhigh'
]);

export function publicModelForRole(role) {
  if (role === 'large') return LARGE_PUBLIC_MODEL;
  if (role === 'storm') return STORM_PUBLIC_MODEL;
  if (role === 'image') return IMAGE_PUBLIC_MODEL;
  return SMALL_PUBLIC_MODEL;
}

export function normalizeModelId(value) {
  return String(value || '').trim();
}

function sameModel(left, right) {
  const a = normalizeModelId(left);
  const b = normalizeModelId(right);
  if (!a || !b) return false;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

export function roleFromRequestedModel(model, endpoints = {}) {
  const raw = normalizeModelId(model);
  if (!raw) return 'small';
  const key = raw.toLowerCase();
  if (key === LARGE_PUBLIC_MODEL || key === LARGE_LEGACY_ALIAS) return 'large';
  if (key === STORM_PUBLIC_MODEL) return 'storm';
  if (key === SMALL_PUBLIC_MODEL || key === SMALL_LEGACY_ALIAS || LEGACY_SMALL_THINKING_ALIASES.has(raw)) {
    return 'small';
  }
  if (key === IMAGE_PUBLIC_MODEL) return 'image';
  if (endpoints.storm?.model && sameModel(raw, endpoints.storm.model)) return 'storm';
  if (endpoints.large?.model && sameModel(raw, endpoints.large.model)) return 'large';
  if (endpoints.image?.model && sameModel(raw, endpoints.image.model)) return 'image';
  if (endpoints.small?.model && sameModel(raw, endpoints.small.model)) return 'small';
  return 'small';
}

export function catalogModel(id, contextWindow) {
  const row = {
    id,
    object: 'model',
    created: 0,
    owned_by: 'ai4es'
  };
  const window = Number(contextWindow);
  if (Number.isFinite(window) && window > 0) {
    const size = Math.floor(window);
    row.max_model_len = size;
    row.context_length = size;
    row.context_window = size;
  }
  return row;
}

export function publicModelsList({ smallWindow, largeWindow, stormWindow } = {}) {
  return {
    object: 'list',
    data: [
      catalogModel(SMALL_PUBLIC_MODEL, smallWindow),
      catalogModel(LARGE_PUBLIC_MODEL, largeWindow),
      catalogModel(STORM_PUBLIC_MODEL, stormWindow),
      catalogModel(IMAGE_PUBLIC_MODEL)
    ]
  };
}

export function rewriteJsonModelField(payload, publicId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (typeof payload.model === 'string') payload.model = publicId;
  return payload;
}

export function rewriteSseEvent(eventText, publicId) {
  return String(eventText || '').replace(/^data: (.+)$/gm, (full, payload) => {
    const trimmed = String(payload || '').trim();
    if (!trimmed || trimmed === '[DONE]') return full;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.model === 'string') {
        parsed.model = publicId;
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
      // 不完整或不含 JSON 的 data 行原样返回
    }
    return full;
  });
}

export class SseModelRewriter {
  constructor(publicId) {
    this.publicId = publicId;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let emitted = '';
    let sep = this.buffer.indexOf('\n\n');
    while (sep >= 0) {
      const event = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      emitted += `${rewriteSseEvent(event, this.publicId)}\n\n`;
      sep = this.buffer.indexOf('\n\n');
    }
    return emitted;
  }

  flush() {
    if (!this.buffer) return '';
    const out = rewriteSseEvent(this.buffer, this.publicId);
    this.buffer = '';
    return out.endsWith('\n\n') ? out : `${out}\n\n`;
  }
}
