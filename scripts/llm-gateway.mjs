/**
 * 本地 LLM Gateway：OpenCode 固定连本机，按 storage/settings.json 动态转发到真实 Base URL。
 * 改小/大/图像模型地址后无需重启 OpenCode sidecar。
 *
 * 路由规则：
 * - 请求头 x-ai4es-model-role: large|small|image
 * - 路径含 /images/ → 图像端点
 * - 请求体 model === ai4es-large|ai4es-small|ai4es-image → 对应端点
 * - 请求体 model 与真实名称一致（兼容）→ 对应上游
 * - 其余 → 小模型（对话默认）
 *
 * 转发前会把 body.model 改写为对应上游真实模型名；OpenCode 侧只使用中性别名。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SETTINGS_PATH = path.join(PROJECT_ROOT, 'storage', 'settings.json');
const PORT = Number(process.env.LLM_GATEWAY_PORT || 4098);
const HOST = process.env.LLM_GATEWAY_HOST || '127.0.0.1';
const SMALL_MODEL_ALIAS = 'ai4es-small';
const LARGE_MODEL_ALIAS = 'ai4es-large';
const IMAGE_MODEL_ALIAS = 'ai4es-image';

const DEFAULT_SMALL = {
  baseUrl: 'http://10.1.4.166:11436/v1',
  model: 'qwen3.6:35b-a3b',
  apiKey: ''
};

const DEFAULT_LARGE = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  apiKey: ''
};

const DEFAULT_IMAGE = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'dall-e-3',
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
    apiKey: stored.small?.apiKey ?? stored.apiKey ?? DEFAULT_SMALL.apiKey
  };
  const large = {
    baseUrl: stored.large?.baseUrl || DEFAULT_LARGE.baseUrl,
    model: stored.large?.model || DEFAULT_LARGE.model,
    apiKey: stored.large?.apiKey ?? DEFAULT_LARGE.apiKey
  };
  const image = {
    baseUrl: stored.image?.baseUrl || DEFAULT_IMAGE.baseUrl,
    model: stored.image?.model || DEFAULT_IMAGE.model,
    apiKey: stored.image?.apiKey ?? DEFAULT_IMAGE.apiKey
  };
  return { small, large, image };
}

function normalizeBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

function isImagesPath(url) {
  const pathOnly = String(url || '').split('?')[0];
  return pathOnly.includes('/images/');
}

function pickRole(req, bodyText) {
  const headerRole = String(req.headers['x-ai4es-model-role'] || '').toLowerCase();
  if (headerRole === 'large' || headerRole === 'small' || headerRole === 'image') return headerRole;
  if (isImagesPath(req.url)) return 'image';

  const { small, large, image } = resolveEndpoints();
  if (!bodyText) return 'small';
  try {
    const parsed = JSON.parse(bodyText);
    const model = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
    if (!model) return 'small';
    if (model === LARGE_MODEL_ALIAS) return 'large';
    if (model === SMALL_MODEL_ALIAS) return 'small';
    if (model === IMAGE_MODEL_ALIAS) return 'image';
    if (large.model && model === large.model) return 'large';
    if (image.model && model === image.model) return 'image';
    if (small.model && model === small.model) return 'small';
  } catch {
    // 非 JSON 体：默认小模型
  }
  return 'small';
}

function rewriteBodyForUpstream(bodyText, upstreamModel, role) {
  if (!bodyText || !upstreamModel) return { body: Buffer.from(bodyText || ''), text: bodyText || '' };
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: Buffer.from(bodyText), text: bodyText };
    }
    parsed.model = upstreamModel;
    if (role === 'large') {
      // 云端大模型固定 high，与本地 none/think 互不影响
      delete parsed.think;
      parsed.reasoning_effort = 'high';
    }
    if (role === 'image') {
      delete parsed.think;
      delete parsed.reasoning_effort;
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

async function proxyRequest(req, res) {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    const endpoints = resolveEndpoints();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'ai4es-llm-gateway',
        largeModelAlias: LARGE_MODEL_ALIAS,
        smallModelAlias: SMALL_MODEL_ALIAS,
        imageModelAlias: IMAGE_MODEL_ALIAS,
        small: { baseUrl: endpoints.small.baseUrl, model: endpoints.small.model },
        large: { baseUrl: endpoints.large.baseUrl, model: endpoints.large.model },
        image: { baseUrl: endpoints.image.baseUrl, model: endpoints.image.model }
      })
    );
    return;
  }

  const rawBody = await readRequestBody(req);
  const bodyText = rawBody.length ? rawBody.toString('utf8') : '';
  const role = pickRole(req, bodyText);
  const endpoints = resolveEndpoints();
  const upstream = endpoints[role];
  const rewritten = rewriteBodyForUpstream(bodyText, upstream.model, role);
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
  if (rewritten.body.length) {
    headers['Content-Length'] = String(rewritten.body.length);
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : rewritten.body,
      redirect: 'manual'
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: {
          message: `LLM Gateway 无法连接上游（${role}）：${detail}`,
          type: 'gateway_error',
          role,
          upstream: upstream.baseUrl,
          model: upstream.model
        }
      })
    );
    return;
  }

  const responseHeaders = {};
  upstreamRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'content-length') return;
    responseHeaders[key] = value;
  });
  responseHeaders['x-ai4es-gateway-role'] = role;
  responseHeaders['x-ai4es-gateway-upstream'] = normalizeBase(upstream.baseUrl);
  responseHeaders['x-ai4es-gateway-model'] = upstream.model;

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
