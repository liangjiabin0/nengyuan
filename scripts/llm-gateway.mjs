/**
 * 本地 LLM Gateway：OpenCode 固定连本机，按 storage/settings.json 动态转发到真实 Base URL。
 * 改 Arc / Thunder / Storm / 图像模型地址后无需重启 OpenCode sidecar。
 *
 * 路由规则：
 * - 请求头 x-ai4es-model-role: large|small|storm|image
 * - 请求头 x-ai4es-thinking: off|low|medium|high|xhigh（子代理思考档，覆盖 body）
 * - 路径含 /images/ → 图像端点（JSON generations 只转发契约字段；multipart edits 透传二进制）
 * - 对内模型名固定：thunder / storm / arc / ai4es-image
 * - 兼容旧别名 ai4es-large|ai4es-small|ai4es-image 与思考档目录名
 * - 请求体 model 与上游真实名称一致（兼容）→ 对应上游
 * - 其余 → Arc（对话默认）
 *
 * /v1/models 只返回 thunder / storm / arc / ai4es-image，不透出上游真实模型名。
 * 转发前把 body.model 改写为上游真实名；响应体再改回对内名。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnthropicSseToOpenAI,
  anthropicAuthHeaders,
  anthropicEndpointUrl,
  anthropicErrorToOpenAI,
  anthropicMessageToOpenAI,
  isChatCompletionsPath,
  isModelsPath,
  openaiChatToAnthropic,
  parseApiFormat
} from './openai-anthropic-compat.mjs';
import {
  IMAGE_PUBLIC_MODEL,
  SseModelRewriter,
  publicModelForRole,
  publicModelsList,
  roleFromRequestedModel,
  rewriteJsonModelField
} from './llm-gateway-models.mjs';
import {
  GATEWAY_MAX_RETRIES,
  fetchUpstreamWithRetry,
  headerTimeoutFor,
  upstreamFetch,
  upstreamRouteState
} from './llm-gateway-retry.mjs';
import {
  ThoughtLeaseHub,
  extractReasoningDeltasFromSse,
  isLoopbackAddress
} from './llm-gateway-thought.mjs';
import { forcesThinkingOff } from './llm-gateway-thinking.mjs';
import {
  roleFromBodyMarker,
  stripMarkersInParsed,
  thinkingFromBodyMarker
} from './llm-gateway-markers.mjs';
import {
  handleSessionRoutingRequest,
  pinnedSessionRouting,
  rememberSessionRouting,
  sessionIdFromRequest
} from './llm-gateway-sessions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SETTINGS_PATH = process.env.LLM_GATEWAY_SETTINGS_PATH || path.join(PROJECT_ROOT, 'storage', 'settings.json');
const PORT = Number(process.env.LLM_GATEWAY_PORT || 4098);
const HOST = process.env.LLM_GATEWAY_HOST || '127.0.0.1';
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const contextWindowCache = new Map();
const thoughtLeases = new ThoughtLeaseHub();
// Model requests currently carry no verified conversation binding. Keep the tap fail-closed.
const UNBOUND_THOUGHT_CONVERSATION_ID = '';

const DEFAULT_SMALL = {
  baseUrl: 'http://10.1.4.166:8000/v1',
  model: 'Arc',
  apiKey: ''
};

const SMALL_INVALID_REASONING = new Set(['none', 'high', 'minimal', 'max']);

const DEFAULT_LARGE = {
  baseUrl: 'https://ai-api.ai-member.icu/v1',
  model: 'gpt-6-sol',
  apiKey: ''
};

const DEFAULT_STORM = {
  baseUrl: 'https://ai-api.ai-member.icu/v1',
  model: 'gpt-6-astra',
  apiKey: ''
};

const DEFAULT_IMAGE = {
  baseUrl: 'https://ai-api.ai-member.icu/v1',
  model: 'gpt-image-2',
  apiKey: ''
};

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function resolveEndpoints() {
  const stored = readJsonSafe(SETTINGS_PATH) || {};
  const small = {
    baseUrl: stored.small?.baseUrl || stored.baseUrl || DEFAULT_SMALL.baseUrl,
    model: stored.small?.model || stored.model || DEFAULT_SMALL.model,
    apiKey: stored.small?.apiKey ?? stored.apiKey ?? DEFAULT_SMALL.apiKey,
    apiFormat: parseApiFormat(stored.small?.apiFormat)
  };
  const large = {
    baseUrl: stored.thunder?.baseUrl || stored.large?.baseUrl || DEFAULT_LARGE.baseUrl,
    model: stored.thunder?.model || stored.large?.model || DEFAULT_LARGE.model,
    apiKey: stored.thunder?.apiKey ?? stored.large?.apiKey ?? DEFAULT_LARGE.apiKey,
    apiFormat: parseApiFormat(stored.thunder?.apiFormat || stored.large?.apiFormat)
  };
  const storm = {
    baseUrl: stored.storm?.baseUrl || large.baseUrl || DEFAULT_STORM.baseUrl,
    model: stored.storm?.model || DEFAULT_STORM.model,
    apiKey: stored.storm?.apiKey ?? large.apiKey ?? DEFAULT_STORM.apiKey,
    apiFormat: parseApiFormat(stored.storm?.apiFormat || large.apiFormat)
  };
  const image = {
    baseUrl: stored.image?.baseUrl || DEFAULT_IMAGE.baseUrl,
    model: stored.image?.model || DEFAULT_IMAGE.model,
    apiKey: stored.image?.apiKey ?? DEFAULT_IMAGE.apiKey,
    apiFormat: 'openai'
  };
  return { small, large, storm, image };
}

function normalizeBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

function isImagesPath(url) {
  const pathOnly = String(url || '').split('?')[0];
  return pathOnly.includes('/images/');
}

function isMultipartRequest(req) {
  return String(req.headers['content-type'] || '').toLowerCase().includes('multipart/form-data');
}

function normalizeImageSize(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === 'auto') return 'auto';
  if (lower === '1024x1024' || lower === '256x256' || lower === '512x512') return '1024x1024';
  if (lower === '1024x1536' || lower === '1024x1792') return '1024x1536';
  if (lower === '1536x1024' || lower === '1792x1024') return '1536x1024';
  return '';
}

function normalizeImageQuality(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === '1k' || lower === 'standard') return '1K';
  if (lower === '2k' || lower === 'hd') return '2K';
  if (lower === '4k') return '4K';
  return '';
}

function rewriteImageJson(parsed, upstreamModel) {
  const next = {
    model: upstreamModel,
    prompt: typeof parsed?.prompt === 'string' ? parsed.prompt : ''
  };
  const n = Number(parsed?.n);
  if (Number.isInteger(n) && n >= 1) next.n = n;
  const size = normalizeImageSize(parsed?.size);
  if (size) next.size = size;
  const quality = normalizeImageQuality(parsed?.quality);
  if (quality) next.quality = quality;
  if (parsed?.response_format === 'url' || parsed?.response_format === 'b64_json') {
    next.response_format = parsed.response_format;
  }
  return next;
}

function rewriteMultipartImageModel(rawBody, alias, upstreamModel) {
  if (!rawBody?.length || !upstreamModel) return rawBody;
  const headLen = Math.min(rawBody.length, 8192);
  const head = rawBody.subarray(0, headLen).toString('latin1');
  if (!alias || alias === upstreamModel || !head.includes(alias)) return rawBody;
  const nextHead = head.replace(alias, upstreamModel);
  return Buffer.concat([Buffer.from(nextHead, 'latin1'), rawBody.subarray(headLen)]);
}

/** 返回值第二项表示这一档是不是子代理路由定的（请求头或 prompt 标记），够格钉住会话。 */
function pickThinking(req, bodyText, sessionId) {
  const header = String(req.headers['x-ai4es-thinking'] || '').toLowerCase();
  if (header === 'none' || header === 'disabled') return { thinking: 'off', pinned: true };
  if (header === 'off' || header === 'low' || header === 'medium' || header === 'high' || header === 'xhigh') {
    return { thinking: header, pinned: true };
  }
  const marker = bodyText ? thinkingFromBodyMarker(bodyText) : null;
  if (marker) return { thinking: marker, pinned: true };
  const pinnedEntry = pinnedSessionRouting(sessionId);
  if (pinnedEntry?.thinking) return { thinking: pinnedEntry.thinking, pinned: true };
  return { thinking: null, pinned: false };
}

function applyThinkingOverride(parsed, thinking) {
  if (!thinking || !parsed || typeof parsed !== 'object') return;
  parsed.chat_template_kwargs = {
    ...(parsed.chat_template_kwargs && typeof parsed.chat_template_kwargs === 'object'
      ? parsed.chat_template_kwargs
      : {})
  };
  if (thinking === 'off') {
    parsed.reasoning_effort = 'none';
    parsed.chat_template_kwargs.enable_thinking = false;
    delete parsed.include_reasoning;
    return;
  }
  parsed.reasoning_effort = thinking;
  parsed.include_reasoning = true;
  parsed.chat_template_kwargs.enable_thinking = true;
  parsed.chat_template_kwargs.preserve_thinking = true;
}

/** 返回值第二项含义同 pickThinking：这一档是不是子代理路由定的。 */
function pickRole(req, bodyText, sessionId) {
  const headerRole = String(req.headers['x-ai4es-model-role'] || '').toLowerCase();
  if (headerRole === 'large' || headerRole === 'small' || headerRole === 'storm' || headerRole === 'image') {
    return { role: headerRole, pinned: true };
  }
  const markerRole = bodyText ? roleFromBodyMarker(bodyText) : null;
  if (markerRole) return { role: markerRole, pinned: true };
  if (isImagesPath(req.url)) return { role: 'image', pinned: false };
  const pinnedEntry = pinnedSessionRouting(sessionId);
  if (pinnedEntry) return { role: pinnedEntry.role, pinned: true };
  if (!bodyText) return { role: 'small', pinned: false };
  try {
    const parsed = JSON.parse(bodyText);
    const model = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
    return { role: roleFromRequestedModel(model, resolveEndpoints()), pinned: false };
  } catch {
    // 非 JSON 体：默认 Arc
  }
  return { role: 'small', pinned: false };
}

/** 请求体最终会带着哪一档思考发给上游，气泡上标的就是它。 */
function effectiveThinking(role, bodyText, override) {
  if (override) return override;
  if (!bodyText) return null;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (role === 'small') {
    if (forcesThinkingOff(parsed)) return 'off';
    return resolveSmallThinking(parsed) ? resolveSmallEffort(parsed) : 'off';
  }
  const effort = String(parsed.reasoning_effort || '').toLowerCase();
  if (!effort || effort === 'none' || effort === 'off') return 'off';
  return effort;
}

function applyLocalSmallExtras(parsed, thinkingOn, effort = 'medium') {
  delete parsed.think;
  if (SMALL_INVALID_REASONING.has(String(parsed.reasoning_effort || '').toLowerCase())) {
    delete parsed.reasoning_effort;
  }
  parsed.chat_template_kwargs = {
    ...(parsed.chat_template_kwargs && typeof parsed.chat_template_kwargs === 'object'
      ? parsed.chat_template_kwargs
      : {})
  };
  if (!thinkingOn) {
    parsed.temperature = 0.7;
    parsed.top_p = 0.8;
    parsed.top_k = 20;
    parsed.min_p = 0;
    parsed.presence_penalty = 1.5;
    parsed.repetition_penalty = 1;
    delete parsed.reasoning_effort;
    delete parsed.include_reasoning;
    parsed.chat_template_kwargs.enable_thinking = false;
    return;
  }
  const reasoningEffort = effort === 'medium' ? 'medium' : 'xhigh';
  parsed.temperature = 0.8;
  parsed.top_p = 0.95;
  parsed.top_k = 20;
  parsed.min_p = 0;
  parsed.presence_penalty = 0.3;
  parsed.repetition_penalty = 1.1;
  parsed.reasoning_effort = reasoningEffort;
  parsed.include_reasoning = true;
  parsed.chat_template_kwargs.enable_thinking = true;
  parsed.chat_template_kwargs.preserve_thinking = true;
  const THINKING_COMPLETION_CAP = 16384;
  const currentMax = parsed.max_tokens ?? parsed.max_completion_tokens;
  const nextMax = currentMax == null || currentMax < 512
    ? 4096
    : Math.min(currentMax, THINKING_COMPLETION_CAP);
  parsed.max_tokens = nextMax;
  if (parsed.max_completion_tokens != null) {
    parsed.max_completion_tokens = nextMax;
  }
}

function thinkingFromLegacyAlias(requestedModel) {
  if (requestedModel === 'ai4es-small-medium' || requestedModel === 'ai4es-small-low') {
    return { on: true, effort: 'medium' };
  }
  if (requestedModel === 'ai4es-small-xhigh') {
    return { on: true, effort: 'xhigh' };
  }
  return null;
}

function resolveSmallEffort(parsed, fallback = 'medium') {
  const effort = String(parsed?.reasoning_effort || '').toLowerCase();
  if (effort === 'xhigh' || effort === 'high') return 'xhigh';
  if (effort === 'medium' || effort === 'low') return 'medium';
  return fallback;
}

function resolveSmallThinking(parsed) {
  const effort = String(parsed?.reasoning_effort || '').toLowerCase();
  if (effort === 'xhigh' || effort === 'high' || effort === 'medium' || effort === 'low') return true;
  if (parsed?.chat_template_kwargs?.enable_thinking === true) return true;
  if (parsed?.chat_template_kwargs?.enable_thinking === false) return false;
  return parsed?.think === true;
}

function fallbackContextWindow(role, model) {
  if (role === 'small') return 131072;
  if (/gpt-6-astra|\bastra\b/i.test(model)) return 272000;
  if (/gpt-6-sol/i.test(model)) return 919387;
  if (/gpt-4\.1|gpt-5/i.test(model)) return 1000000;
  if (/claude/i.test(model)) return 200000;
  if (/deepseek/i.test(model)) return 128000;
  if (/gemini/i.test(model)) return 1000000;
  return 128000;
}

function readContextWindow(model) {
  const directKeys = [
    'max_model_len',
    'max_context_length',
    'context_length',
    'context_window',
    'max_sequence_length',
    'max_position_embeddings',
    'max_input_tokens',
    'max_tokens',
    'n_ctx'
  ];
  for (const key of directKeys) {
    const found = Number(model?.[key]);
    if (Number.isFinite(found) && found > 0) return Math.floor(found);
  }
  return null;
}

function modelsListUrl(upstream) {
  const format = parseApiFormat(upstream.apiFormat);
  if (format === 'anthropic') return anthropicEndpointUrl(upstream.baseUrl, 'models');
  const base = normalizeBase(upstream.baseUrl);
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

async function probeUpstreamContextWindow(role, upstream) {
  const cacheKey = `${role}:${upstream.baseUrl}:${upstream.model}`;
  const cached = contextWindowCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.window;

  let window = null;
  try {
    const headers = { Accept: 'application/json', 'accept-encoding': 'identity' };
    const format = parseApiFormat(upstream.apiFormat);
    if (format === 'anthropic') {
      Object.assign(headers, anthropicAuthHeaders(upstream.apiKey));
    } else if (upstream.apiKey) {
      headers.Authorization = `Bearer ${upstream.apiKey}`;
    }
    const response = await upstreamFetch(modelsListUrl(upstream), {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000)
    });
    if (response.ok) {
      const payload = await response.json();
      const models = (Array.isArray(payload) ? payload : payload?.data || [])
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
      const wanted = String(upstream.model || '').toLowerCase();
      const selected = models.find((item) => {
        const id = String(item.id || item.name || '').toLowerCase();
        return id === wanted || id.endsWith(`/${wanted}`) || id.endsWith(`:${wanted}`);
      });
      if (selected) window = readContextWindow(selected);
    }
  } catch {
    // 目录探测失败时用保守回退，不把上游模型名回给客户端。
  }
  if (!window) window = fallbackContextWindow(role, upstream.model);
  contextWindowCache.set(cacheKey, { window, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
  return window;
}

async function writePublicModelsCatalog(res) {
  const endpoints = resolveEndpoints();
  const [smallWindow, largeWindow, stormWindow] = await Promise.all([
    probeUpstreamContextWindow('small', endpoints.small),
    probeUpstreamContextWindow('large', endpoints.large),
    probeUpstreamContextWindow('storm', endpoints.storm)
  ]);
  const body = JSON.stringify(publicModelsList({ smallWindow, largeWindow, stormWindow }));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function rewriteBodyForUpstream(bodyText, upstreamModel, role, requestedModel, thinkingOverride) {
  if (!bodyText || !upstreamModel) return { body: Buffer.from(bodyText || ''), text: bodyText || '' };
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: Buffer.from(bodyText), text: bodyText };
    }
    if (role === 'image') {
      const text = JSON.stringify(rewriteImageJson(parsed, upstreamModel));
      return { body: Buffer.from(text), text };
    }
    parsed.model = upstreamModel;
    applyThinkingOverride(parsed, thinkingOverride);
    stripMarkersInParsed(parsed);
    if (parsed.stream) {
      parsed.stream_options = {
        ...(parsed.stream_options && typeof parsed.stream_options === 'object'
          ? parsed.stream_options
          : {}),
        include_usage: true
      };
    }
    if (role === 'small') {
      const legacy = thinkingFromLegacyAlias(requestedModel);
      const thinkingOn = !forcesThinkingOff(parsed)
        && (legacy?.on === true || resolveSmallThinking(parsed));
      applyLocalSmallExtras(
        parsed,
        thinkingOn,
        legacy?.effort || resolveSmallEffort(parsed)
      );
    }
    if (role === 'large' || role === 'storm') {
      applyCloudThinking(parsed);
    }
    const text = JSON.stringify(parsed);
    return { body: Buffer.from(text), text };
  } catch {
    return { body: Buffer.from(bodyText), text: bodyText };
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildTargetUrl(upstreamBase, incomingUrl) {
  const base = normalizeBase(upstreamBase);
  const raw = incomingUrl || '/';
  const pathAndQuery = raw.startsWith('/') ? raw : `/${raw}`;
  if (base.endsWith('/v1') && pathAndQuery.startsWith('/v1')) {
    return `${base}${pathAndQuery.slice(3)}` || `${base}/`;
  }
  return `${base}${pathAndQuery}`;
}

function applyCloudThinking(parsed) {
  delete parsed.think;
  const effort = String(parsed?.reasoning_effort || '').toLowerCase();
  if (!effort || effort === 'none' || effort === 'off' || parsed?.chat_template_kwargs?.enable_thinking === false) {
    delete parsed.reasoning_effort;
    delete parsed.include_reasoning;
    return;
  }
  parsed.include_reasoning = true;
}

function publishSmallThoughts(role, conversationId, sseText) {
  if (role !== 'small' || !conversationId || !sseText) return;
  for (const delta of extractReasoningDeltasFromSse(sseText)) {
    thoughtLeases.publish(conversationId, delta);
  }
}

function handleThoughtStream(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method !== 'GET' || url.pathname !== '/internal/thought-stream') return false;
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'thought stream is loopback-only' } }));
    return true;
  }
  const conversationId = url.searchParams.get('conversationId')?.trim() || '';
  const sessionId = url.searchParams.get('sessionId')?.trim() || '';
  if (!conversationId || !sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'conversationId and sessionId are required' } }));
    return true;
  }
  const send = (text, publishedSessionId) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type: 'delta', text, sessionId: publishedSessionId })}\n\n`);
  };
  const release = thoughtLeases.add(
    conversationId,
    sessionId,
    send
  );
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  try {
    req.socket?.setNoDelay?.(true);
  } catch {
    // ignore
  }
  req.on('close', release);
  res.on('close', release);
  res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
  return true;
}

function writeGatewayConnectError(res, role, upstream, error) {
  const detail = error instanceof Error ? error.message : String(error);
  res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    error: {
      message: `LLM Gateway 无法连接上游（${role}）：${detail}`,
      type: 'gateway_error',
      role,
      upstream: upstream.baseUrl,
      model: publicModelForRole(role)
    }
  }));
}

function gatewayMetaHeaders(role, upstream, extra = {}) {
  return {
    ...extra,
    'x-ai4es-gateway-role': role,
    'x-ai4es-gateway-upstream': normalizeBase(upstream.baseUrl),
    'x-ai4es-gateway-model': publicModelForRole(role),
    'x-ai4es-gateway-format': 'anthropic'
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: String(text || '').slice(0, 300) };
  }
}

function gatewayRetryLog(role, kind, attempt, reason, error) {
  const route = error?.gatewayRoute ? ` via ${error.gatewayRoute}` : '';
  console.warn(`[llm-gateway] ${new Date().toISOString()} ${kind} ${role} retry ${attempt}/${GATEWAY_MAX_RETRIES}${route}: ${reason}`);
}

/** 客户端（OpenCode）断开后立即中止上游，免得上游继续为没人要的请求生成。 */
function abortOnClientClose(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new Error('client_closed'));
  });
  return controller.signal;
}

function isStreamRequest(bodyText) {
  if (!bodyText) return false;
  try {
    return JSON.parse(bodyText)?.stream === true;
  } catch {
    return false;
  }
}

async function proxyAnthropic(req, res, { role, upstream, bodyText, thinkingOverride }) {
  const url = req.url || '/';
  const method = (req.method || 'GET').toUpperCase();
  const headers = {
    ...anthropicAuthHeaders(upstream.apiKey),
    'accept-encoding': 'identity'
  };

  if (method === 'GET' && isModelsPath(url)) {
    await writePublicModelsCatalog(res);
    return true;
  }

  if (method !== 'POST' || !isChatCompletionsPath(url)) return false;

  let parsed = {};
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    parsed = {};
  }
  parsed.model = upstream.model;
  applyThinkingOverride(parsed, thinkingOverride);
  stripMarkersInParsed(parsed);
  if (role === 'large' || role === 'storm') {
    applyCloudThinking(parsed);
  }
  const anthropicBody = openaiChatToAnthropic(parsed, upstream.model);
  const payload = JSON.stringify(anthropicBody);
  headers['Content-Type'] = 'application/json';
  headers['Content-Length'] = String(Buffer.byteLength(payload));

  let upstreamRes;
  try {
    upstreamRes = await fetchUpstreamWithRetry(anthropicEndpointUrl(upstream.baseUrl, 'messages'), {
      method: 'POST',
      headers,
      body: payload,
      redirect: 'manual',
      signal: abortOnClientClose(res)
    }, {
      headerTimeoutMs: headerTimeoutFor({ role, stream: anthropicBody.stream === true }),
      onRetry: (attempt, reason, error) => gatewayRetryLog(role, 'anthropic', attempt, reason, error)
    });
  } catch (error) {
    if (res.destroyed) return true;
    writeGatewayConnectError(res, role, upstream, error);
    return true;
  }

  if (anthropicBody.stream) {
    if (!upstreamRes.ok || !upstreamRes.body) {
      const text = await upstreamRes.text().catch(() => '');
      res.writeHead(upstreamRes.status || 502, gatewayMetaHeaders(role, upstream, {
        'Content-Type': 'application/json; charset=utf-8'
      }));
      res.end(JSON.stringify(anthropicErrorToOpenAI(safeJson(text))));
      return true;
    }
    res.writeHead(200, gatewayMetaHeaders(role, upstream, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache'
    }));
    const publicId = publicModelForRole(role);
    const decoder = new TextDecoder();
    const transformer = new AnthropicSseToOpenAI(publicId, { lockModel: true });
    const reader = upstreamRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const out = transformer.push(decoder.decode(value, { stream: true }));
        if (out) {
          publishSmallThoughts(role, UNBOUND_THOUGHT_CONVERSATION_ID, out);
          res.write(out);
        }
      }
      const tail = transformer.flush();
      if (tail) {
        publishSmallThoughts(role, UNBOUND_THOUGHT_CONVERSATION_ID, tail);
        res.write(tail);
      }
      res.end();
    } catch (error) {
      try {
        res.destroy(error instanceof Error ? error : undefined);
      } catch {
        // ignore
      }
    }
    return true;
  }

  const text = await upstreamRes.text();
  const jsonHeaders = gatewayMetaHeaders(role, upstream, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  if (!upstreamRes.ok) {
    res.writeHead(upstreamRes.status, jsonHeaders);
    res.end(JSON.stringify(anthropicErrorToOpenAI(safeJson(text))));
    return true;
  }
  res.writeHead(200, jsonHeaders);
  res.end(JSON.stringify(anthropicMessageToOpenAI(safeJson(text), publicModelForRole(role))));
  return true;
}

async function proxyRequest(req, res) {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    const endpoints = resolveEndpoints();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'ai4es-llm-gateway',
        largeModelAlias: publicModelForRole('large'),
        smallModelAlias: publicModelForRole('small'),
        stormModelAlias: publicModelForRole('storm'),
        imageModelAlias: publicModelForRole('image'),
        small: { baseUrl: endpoints.small.baseUrl, model: endpoints.small.model, apiFormat: endpoints.small.apiFormat },
        large: { baseUrl: endpoints.large.baseUrl, model: endpoints.large.model, apiFormat: endpoints.large.apiFormat },
        storm: { baseUrl: endpoints.storm.baseUrl, model: endpoints.storm.model, apiFormat: endpoints.storm.apiFormat },
        image: { baseUrl: endpoints.image.baseUrl, model: endpoints.image.model },
        uptimeSec: Math.round(process.uptime()),
        routes: upstreamRouteState()
      })
    );
    return;
  }

  if (req.method === 'GET' && isModelsPath(req.url)) {
    await writePublicModelsCatalog(res);
    return;
  }

  if (handleThoughtStream(req, res)) return;
  if (handleSessionRoutingRequest(req, res)) return;

  const rawBody = await readRequestBody(req);
  const multipart = isMultipartRequest(req);
  const bodyText = !multipart && rawBody.length ? rawBody.toString('utf8') : '';
  const sessionId = sessionIdFromRequest(req);
  const picked = pickRole(req, bodyText, sessionId);
  const role = picked.role;
  const pickedThinking = pickThinking(req, bodyText, sessionId);
  const thinkingOverride = pickedThinking.thinking;
  rememberSessionRouting(sessionId, {
    role,
    thinking: effectiveThinking(role, bodyText, thinkingOverride),
    pinned: picked.pinned || pickedThinking.pinned
  });
  const endpoints = resolveEndpoints();
  const upstream = endpoints[role];
  let requestedModel = '';
  try {
    if (bodyText) {
      const parsed = JSON.parse(bodyText);
      requestedModel = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
    }
  } catch {
    requestedModel = '';
  }
  const apiFormat = role === 'image' ? 'openai' : parseApiFormat(upstream.apiFormat);
  if (apiFormat === 'anthropic' && !multipart) {
    const handled = await proxyAnthropic(req, res, { role, upstream, bodyText, thinkingOverride });
    if (handled) return;
  }
  const rewritten = multipart
    ? {
        body: role === 'image'
          ? rewriteMultipartImageModel(rawBody, IMAGE_PUBLIC_MODEL, upstream.model)
          : rawBody,
        text: ''
      }
    : rewriteBodyForUpstream(bodyText, upstream.model, role, requestedModel, thinkingOverride);
  const targetUrl = buildTargetUrl(upstream.baseUrl, req.url);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
    if (lower === 'authorization') continue;
    if (lower.startsWith('x-ai4es-')) continue;
    headers[key] = Array.isArray(value) ? value.join(',') : value;
  }
  if (upstream.apiKey) {
    headers.Authorization = `Bearer ${upstream.apiKey}`;
  }
  if (role === 'image' && !headers['idempotency-key']) {
    headers['idempotency-key'] = crypto.randomUUID();
  }
  // 避免上游 gzip 与 fetch 自动解压叠在一起
  headers['accept-encoding'] = 'identity';
  if (rewritten.body.length) {
    headers['Content-Length'] = String(rewritten.body.length);
  }

  let upstreamRes;
  try {
    upstreamRes = await fetchUpstreamWithRetry(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : rewritten.body,
      redirect: 'manual',
      signal: abortOnClientClose(res)
    }, {
      headerTimeoutMs: headerTimeoutFor({ role, stream: isStreamRequest(rewritten.text) }),
      onRetry: (attempt, reason, error) => gatewayRetryLog(role, 'openai', attempt, reason, error)
    });
  } catch (error) {
    if (res.destroyed) return;
    const detail = error instanceof Error ? error.message : String(error);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: {
          message: `LLM Gateway 无法连接上游（${role}）：${detail}`,
          type: 'gateway_error',
          role,
          upstream: upstream.baseUrl,
          model: publicModelForRole(role)
        }
      })
    );
    return;
  }

  const responseHeaders = {};
  upstreamRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'content-length') return;
    // undici fetch 会自动解压；不能把 content-encoding 原样回传，否则客户端二次解压失败
    if (lower === 'content-encoding' || lower === 'content-length') return;
    responseHeaders[key] = value;
  });
  responseHeaders['x-ai4es-gateway-role'] = role;
  responseHeaders['x-ai4es-gateway-upstream'] = normalizeBase(upstream.baseUrl);
  responseHeaders['x-ai4es-gateway-model'] = publicModelForRole(role);
  try {
    if (rewritten.text) {
      const sent = JSON.parse(rewritten.text);
      if (sent?.reasoning_effort) responseHeaders['x-ai4es-gateway-effort'] = String(sent.reasoning_effort);
    }
  } catch {
    // ignore
  }

  const publicId = publicModelForRole(role);
  const contentType = String(upstreamRes.headers.get('content-type') || '');
  let streamed = false;
  try {
    streamed = Boolean(rewritten.text && JSON.parse(rewritten.text)?.stream);
  } catch {
    streamed = false;
  }
  const isSse = streamed || contentType.includes('text/event-stream');
  const isJson = contentType.includes('application/json');

  if (isSse) {
    res.writeHead(upstreamRes.status, responseHeaders);
    if (!upstreamRes.body) {
      res.end();
      return;
    }
    const rewriter = new SseModelRewriter(publicId);
    const decoder = new TextDecoder();
    const reader = upstreamRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const out = rewriter.push(decoder.decode(value, { stream: true }));
        if (out) {
          publishSmallThoughts(role, UNBOUND_THOUGHT_CONVERSATION_ID, out);
          res.write(out);
        }
      }
      const tail = rewriter.flush();
      if (tail) {
        publishSmallThoughts(role, UNBOUND_THOUGHT_CONVERSATION_ID, tail);
        res.write(tail);
      }
      res.end();
    } catch (error) {
      try {
        res.destroy(error instanceof Error ? error : undefined);
      } catch {
        // ignore
      }
    }
    return;
  }

  if (isJson) {
    const text = await upstreamRes.text();
    let body = text;
    try {
      body = JSON.stringify(rewriteJsonModelField(JSON.parse(text), publicId));
    } catch {
      body = text;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(body);
    return;
  }

  res.writeHead(upstreamRes.status, responseHeaders);
  if (!upstreamRes.body) {
    res.end();
    return;
  }

  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    try {
      res.destroy(error instanceof Error ? error : undefined);
    } catch {
      // ignore
    }
  }
}

const server = http.createServer((req, res) => {
  proxyRequest(req, res).catch((error) => {
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {
        // ignore
      }
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'gateway_internal_error'
        }
      })
    );
  });
});

// OpenCode 复用长连接；空闲关闭时间要长于客户端，避免它拿到刚被关掉的连接。
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 0;
server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});
server.on('error', (error) => {
  console.error(`[llm-gateway] ${new Date().toISOString()} server error: ${error?.stack || error}`);
  if (error?.code === 'EADDRINUSE') process.exit(1);
});

// 网关是所有对话的唯一出口。单个请求里漏掉的异常只记日志，不能拖垮整个进程。
process.on('uncaughtException', (error) => {
  console.error(`[llm-gateway] ${new Date().toISOString()} uncaught exception: ${error?.stack || error}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[llm-gateway] ${new Date().toISOString()} unhandled rejection: ${reason?.stack || reason}`);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[llm-gateway] listening on http://${HOST}:${PORT}/v1`);
  // eslint-disable-next-line no-console
  console.log(`[llm-gateway] settings=${SETTINGS_PATH}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
