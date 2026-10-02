import { getModelEndpoint, type ModelEndpointSettings } from './config';
import { optimizeImagePrompt, parseOptimizePromptFlag } from './image-prompt-optimize';

export const DEFAULT_IMAGE_BASE_URL = 'https://ai-api.ai-member.icu/v1';
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export const IMAGE_PROMPT_MAX_CHARS = 8000;
export const IMAGE_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const;
export const IMAGE_QUALITIES = ['1K', '2K', '4K'] as const;
export const IMAGE_MAX_REFERENCE_FILES = 8;
export const IMAGE_MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_MASK_BYTES = 4 * 1024 * 1024;

export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type ImageResponseFormat = 'url' | 'b64_json';

export type GenerateImageOptions = {
  prompt: string;
  model?: string;
  n?: number;
  size?: ImageSize | string;
  quality?: ImageQuality | string;
  responseFormat?: ImageResponseFormat;
  idempotencyKey?: string;
  requestId?: string;
  settings?: ModelEndpointSettings;
  signal?: AbortSignal;
  /** 缺省跟随设置页 image.optimizePrompt（默认开） */
  optimizePrompt?: boolean;
};

export type ImageEditFile = {
  buffer: Buffer | Uint8Array;
  filename: string;
  contentType?: string;
};

export type EditImageOptions = {
  prompt: string;
  images: Array<File | Blob | ImageEditFile>;
  mask?: File | Blob | ImageEditFile;
  model?: string;
  n?: number;
  size?: ImageSize | string;
  quality?: ImageQuality | string;
  responseFormat?: ImageResponseFormat;
  idempotencyKey?: string;
  requestId?: string;
  settings?: ModelEndpointSettings;
  signal?: AbortSignal;
  optimizePrompt?: boolean;
};

export type GenerateImageResult = {
  model: string;
  baseUrl: string;
  created?: number;
  images: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  usage?: unknown;
  requestId?: string;
  raw: unknown;
  prompt?: string;
  originalPrompt?: string;
  promptOptimized?: boolean;
};

export function normalizeImageSize(value: unknown): ImageSize {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return 'auto';
  const lower = raw.toLowerCase().replace(/\s+/g, '');
  const landscape = new Set([
    '1536x1024',
    '1792x1024',
    '16:9',
    '16x9',
    '1920x1080',
    '1280x720',
    '1536x864',
    'landscape',
    'widescreen'
  ]);
  const portrait = new Set([
    '1024x1536',
    '1024x1792',
    '9:16',
    '9x16',
    '1080x1920',
    '720x1280',
    'portrait'
  ]);
  if (lower === '1024x1024' || lower === '256x256' || lower === '512x512' || lower === 'square') {
    return '1024x1024';
  }
  if (landscape.has(lower)) return '1536x1024';
  if (portrait.has(lower)) return '1024x1536';
  throw new Error(`不支持的图像尺寸 ${raw}（允许 auto / 1024x1024 / 1024x1536 / 1536x1024，16:9 会映射为 1536x1024）`);
}

export function normalizeImageQuality(value: unknown): ImageQuality {
  const raw = String(value || '').trim();
  if (!raw) return '2K';
  const lower = raw.toLowerCase();
  if (lower === '1k' || lower === 'standard') return '1K';
  if (lower === '2k' || lower === 'hd') return '2K';
  if (lower === '4k') return '4K';
  throw new Error(`不支持的图像质量 ${raw}（允许 1K / 2K / 4K）`);
}

function normalizePrompt(prompt: string) {
  const text = prompt.trim();
  if (!text) throw new Error('图像生成需要 prompt');
  if ([...text].length > IMAGE_PROMPT_MAX_CHARS) {
    throw new Error(`prompt 不能超过 ${IMAGE_PROMPT_MAX_CHARS} 个字符`);
  }
  return text;
}

function normalizeCount(value: unknown, fallback = 1) {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error('n 必须是大于等于 1 的整数');
  return n;
}

function imageContentType(filename: string, fallback = 'image/png') {
  switch (String(filename || '').split('.').pop()?.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'png':
      return 'image/png';
    default:
      return fallback;
  }
}

function toNamedBlob(input: File | Blob | ImageEditFile, fallbackName: string) {
  if (typeof File !== 'undefined' && input instanceof File) {
    return { blob: input, filename: input.name || fallbackName };
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return { blob: input, filename: fallbackName };
  }
  const file = input as ImageEditFile;
  const filename = file.filename || fallbackName;
  const type = file.contentType || imageContentType(filename);
  const bytes = file.buffer instanceof Uint8Array ? file.buffer : new Uint8Array(file.buffer);
  // Copy the view only. Node Buffer may sit on a pooled ArrayBuffer larger than
  // the file; passing bytes.buffer would upload trailing garbage.
  const owned = Uint8Array.from(bytes);
  return {
    blob: new Blob([owned], { type }),
    filename
  };
}

function imageHeaders(settings: ModelEndpointSettings, options: {
  json?: boolean;
  idempotencyKey?: string;
  requestId?: string;
}) {
  const headers: Record<string, string> = {};
  if (options.json) headers['Content-Type'] = 'application/json';
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  headers['Idempotency-Key'] = (options.idempotencyKey || crypto.randomUUID()).slice(0, 128);
  if (options.requestId) headers['X-Request-ID'] = options.requestId.slice(0, 128);
  return headers;
}

function formatImageApiError(status: number, text: string) {
  try {
    const json = JSON.parse(text) as {
      code?: string;
      message?: string;
      error?: { message?: string; type?: string; code?: string; request_id?: string };
    };
    const err = json.error;
    const message = err?.message || json.message || text.slice(0, 300);
    const type = err?.type || err?.code || json.code || '';
    const requestId = err?.request_id ? ` request_id=${err.request_id}` : '';
    if (
      type === 'model_not_found'
      || /not supported by any configured account/i.test(message)
    ) {
      return `Image API HTTP ${status}: 当前图像 Key 所在分组不支持该模型。请在模型配置页更换具备 gpt-image-2 / Images 权限的 Key。${requestId}`;
    }
    return `Image API HTTP ${status}: ${message}${requestId}`;
  } catch {
    return `Image API HTTP ${status}: ${text.slice(0, 300)}`;
  }
}

function parseImageResponse(text: string, model: string, baseUrl: string, requestId?: string): GenerateImageResult {
  let json: {
    created?: number;
    data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
    usage?: unknown;
  };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(`无法解析图像 API 响应: ${text.slice(0, 200)}`);
  }
  const images = Array.isArray(json.data) ? json.data : [];
  if (!images.length) throw new Error('图像 API 未返回任何图片');
  return {
    model,
    baseUrl,
    created: json.created,
    images,
    usage: json.usage,
    requestId,
    raw: json
  };
}

async function resolveGenerationPrompt(
  options: { prompt: string; optimizePrompt?: boolean; signal?: AbortSignal },
  settings: ModelEndpointSettings,
  mode: 'text2image' | 'image2image'
) {
  const originalPrompt = normalizePrompt(options.prompt);
  const enabled = options.optimizePrompt
    ?? parseOptimizePromptFlag(process.env.IMAGE_OPTIMIZE_PROMPT)
    ?? settings.optimizePrompt !== false;
  if (!enabled) {
    return { prompt: originalPrompt, originalPrompt, promptOptimized: false };
  }
  const result = await optimizeImagePrompt(originalPrompt, { mode, signal: options.signal });
  return {
    prompt: result.prompt,
    originalPrompt,
    promptOptimized: result.optimized
  };
}

function withPromptMeta(
  result: GenerateImageResult,
  meta: { prompt: string; originalPrompt: string; promptOptimized: boolean }
): GenerateImageResult {
  const images = result.images.map((image, index) => {
    if (index !== 0 || image.revised_prompt || !meta.promptOptimized) return image;
    return { ...image, revised_prompt: meta.prompt };
  });
  return { ...result, images, ...meta };
}

/**
 * OpenAI Images 兼容同步生成（AI Member / gpt-image-2）。
 * 按公开契约只发送 model/prompt/n/size/quality/response_format。
 */
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const settings = options.settings || getModelEndpoint('image');
  const prepared = await resolveGenerationPrompt(options, settings, 'text2image');
  const prompt = prepared.prompt;
  const baseUrl = settings.baseUrl.replace(/\/$/, '');
  const model = options.model || settings.model;
  const headers = imageHeaders(settings, {
    json: true,
    idempotencyKey: options.idempotencyKey,
    requestId: options.requestId
  });

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      prompt,
      n: normalizeCount(options.n, 1),
      size: normalizeImageSize(options.size || '1024x1024'),
      quality: normalizeImageQuality(options.quality || '2K'),
      response_format: options.responseFormat === 'b64_json' ? 'b64_json' : 'url'
    }),
    signal: options.signal || AbortSignal.timeout(180_000)
  });

  const text = await response.text();
  if (!response.ok) throw new Error(formatImageApiError(response.status, text));
  return withPromptMeta(
    parseImageResponse(text, model, baseUrl, response.headers.get('x-request-id') || undefined),
    prepared
  );
}

/**
 * OpenAI Images 兼容同步编辑：最多 8 张参考图 + 可选 PNG mask。
 */
export async function editImage(options: EditImageOptions): Promise<GenerateImageResult> {
  const settings = options.settings || getModelEndpoint('image');
  const prepared = await resolveGenerationPrompt(options, settings, 'image2image');
  const prompt = prepared.prompt;
  const images = Array.isArray(options.images) ? options.images : [];
  if (images.length < 1 || images.length > IMAGE_MAX_REFERENCE_FILES) {
    throw new Error(`图像编辑需要 1–${IMAGE_MAX_REFERENCE_FILES} 张参考图`);
  }

  const baseUrl = settings.baseUrl.replace(/\/$/, '');
  const model = options.model || settings.model;
  const body = new FormData();
  body.set('model', model);
  body.set('prompt', prompt);
  body.set('n', String(normalizeCount(options.n, 1)));
  body.set('size', normalizeImageSize(options.size || '1024x1024'));
  body.set('quality', normalizeImageQuality(options.quality || '2K'));
  body.set('response_format', options.responseFormat === 'b64_json' ? 'b64_json' : 'url');

  images.forEach((image, index) => {
    const named = toNamedBlob(image, `image-${index + 1}.png`);
    if ('size' in named.blob && named.blob.size > IMAGE_MAX_REFERENCE_BYTES) {
      throw new Error(`参考图 ${named.filename} 超过 10 MiB`);
    }
    body.append('image', named.blob, named.filename);
  });

  if (options.mask) {
    const mask = toNamedBlob(options.mask, 'mask.png');
    if ('size' in mask.blob && mask.blob.size > IMAGE_MAX_MASK_BYTES) {
      throw new Error('mask 不能超过 4 MiB');
    }
    body.set('mask', mask.blob, mask.filename);
  }

  const response = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: imageHeaders(settings, {
      idempotencyKey: options.idempotencyKey,
      requestId: options.requestId
    }),
    body,
    signal: options.signal || AbortSignal.timeout(180_000)
  });

  const text = await response.text();
  if (!response.ok) throw new Error(formatImageApiError(response.status, text));
  return withPromptMeta(
    parseImageResponse(text, model, baseUrl, response.headers.get('x-request-id') || undefined),
    prepared
  );
}

/** 连通性测试：只打 GET /models，确认 Key 能列出当前图像模型（不生图、不计费）。 */
export async function testImageConnection(settings = getModelEndpoint('image')) {
  const baseUrl = settings.baseUrl.replace(/\/$/, '');
  const model = String(settings.model || '').trim();
  if (!baseUrl) throw new Error('未配置图像接口 Base URL');
  if (!settings.apiKey) throw new Error('未配置图像 API Key，请在模型配置页保存');
  if (!model) throw new Error('未配置图像模型');

  const response = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(formatImageApiError(response.status, text));

  let ids: string[] = [];
  try {
    const json = JSON.parse(text) as { data?: Array<{ id?: string; model?: string }> };
    ids = (Array.isArray(json.data) ? json.data : [])
      .map((row) => String(row?.id || row?.model || '').trim())
      .filter(Boolean);
  } catch {
    throw new Error('图像接口 /models 返回无法解析');
  }
  if (!ids.some((id) => id.toLowerCase() === model.toLowerCase())) {
    throw new Error(`当前 Key 未开通图像模型 ${model}（/models 目录中没有该模型，请更换具备 Images 权限的 Key）`);
  }
  return `连接正常（${model} 已出现在模型目录）`;
}
