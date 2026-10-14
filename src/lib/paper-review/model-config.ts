import fs from 'node:fs';
import path from 'node:path';

/**
 * 论文智能评审专用模型端点。
 * 存在 storage/settings.json 的 paperReview 段（与其它模型配置同一文件，但互不影响）；
 * 未在页面保存时回退到环境变量 PAPER_REVIEW_BASE_URL / PAPER_REVIEW_API_KEY / PAPER_REVIEW_MODEL。
 * API Key 只在服务端读取，接口只返回 hasApiKey。
 */
export type PaperReviewThinking = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export type PaperReviewModelConfig = {
  baseUrl: string;
  apiKey: string;
  /** 首选模型 ID（上游真实名称），默认 gpt-6.1-sol */
  model: string;
  /** 首选思考档位，默认 high */
  thinking: PaperReviewThinking;
  /** 首选模型不可用时，是否允许回退到系统 Storm 档；默认 false，必须由用户明确开启 */
  allowStormFallback: boolean;
  /** 可选 HTTP 代理（如 http://127.0.0.1:7897），只用于论文智能评审的模型请求 */
  proxyUrl: string;
};

export const PAPER_REVIEW_DEFAULT_MODEL = 'gpt-6.1-sol';
export const PAPER_REVIEW_DEFAULT_THINKING: PaperReviewThinking = 'high';
export const PAPER_REVIEW_THINKING_LEVELS: PaperReviewThinking[] = ['none', 'low', 'medium', 'high', 'xhigh'];

const settingsPath = () => path.join(process.cwd(), 'storage', 'settings.json');

function readRaw(): Record<string, unknown> {
  try {
    if (!fs.existsSync(settingsPath())) return {};
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^﻿/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isPaperReviewThinking(value: unknown): value is PaperReviewThinking {
  return typeof value === 'string' && (PAPER_REVIEW_THINKING_LEVELS as string[]).includes(value);
}

/** 去掉末尾斜杠和多余的 /v1，统一成不带 /v1 的根地址；调用时再拼 /v1/...。 */
export function normalizePaperReviewBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function getPaperReviewModelConfig(): PaperReviewModelConfig {
  const stored = (readRaw().paperReview || {}) as Partial<PaperReviewModelConfig>;
  const baseUrl = normalizePaperReviewBaseUrl(String(stored.baseUrl || process.env.PAPER_REVIEW_BASE_URL || ''));
  return {
    baseUrl,
    apiKey: String(stored.apiKey || process.env.PAPER_REVIEW_API_KEY || ''),
    model: String(stored.model || process.env.PAPER_REVIEW_MODEL || PAPER_REVIEW_DEFAULT_MODEL).trim(),
    thinking: isPaperReviewThinking(stored.thinking) ? stored.thinking : PAPER_REVIEW_DEFAULT_THINKING,
    allowStormFallback: stored.allowStormFallback === true,
    proxyUrl: String(stored.proxyUrl ?? process.env.PAPER_REVIEW_PROXY ?? '').trim()
  };
}

export type PaperReviewModelPatch = {
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  thinking?: PaperReviewThinking;
  allowStormFallback?: boolean;
  proxyUrl?: string;
};

export function savePaperReviewModelConfig(patch: PaperReviewModelPatch): PaperReviewModelConfig {
  const raw = readRaw();
  const current = getPaperReviewModelConfig();
  const next: PaperReviewModelConfig = {
    baseUrl: patch.baseUrl !== undefined ? normalizePaperReviewBaseUrl(patch.baseUrl) : current.baseUrl,
    apiKey: patch.clearApiKey ? '' : patch.apiKey?.trim() ? patch.apiKey.trim() : current.apiKey,
    model: patch.model?.trim() || current.model,
    thinking: patch.thinking ?? current.thinking,
    allowStormFallback: patch.allowStormFallback ?? current.allowStormFallback,
    proxyUrl: patch.proxyUrl !== undefined ? patch.proxyUrl.trim() : current.proxyUrl
  };
  if (next.proxyUrl && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/i.test(next.proxyUrl)) throw new Error('代理地址格式应为 http://主机:端口');
  if (next.baseUrl && !/^https?:\/\//i.test(next.baseUrl)) throw new Error('接口地址必须以 http:// 或 https:// 开头。');
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const tmp = `${settingsPath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...raw, paperReview: next }, null, 2));
  fs.renameSync(tmp, settingsPath());
  return next;
}

/** 给前端的安全视图：不含 Key。 */
export function publicPaperReviewModelConfig(config = getPaperReviewModelConfig()) {
  return {
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKey),
    model: config.model,
    thinking: config.thinking,
    allowStormFallback: config.allowStormFallback,
    proxyUrl: config.proxyUrl
  };
}
