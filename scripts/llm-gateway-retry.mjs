import { createUpstreamTransport } from './llm-gateway-transport.mjs';

/** 首次失败后再试 5 次。间隔 1s、2s、5s、15s、30s。 */
export const GATEWAY_MAX_RETRIES = 5;
export const GATEWAY_HEADER_TIMEOUT_MS = 20_000;
// 流式请求：上游开始处理就回响应头，但云端大上下文的预填充可能要几十秒。
const STREAM_HEADER_TIMEOUT_MS = { small: 60_000, cloud: 120_000 };
// 非流式请求：整段生成完才有响应头，按整次生成的时长给。
const NON_STREAM_HEADER_TIMEOUT_MS = 600_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

export function isRetryableError(error, clientAborted = false) {
  if (clientAborted) return false;
  const name = String(error?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const message = [
    error?.message,
    error?.cause instanceof Error ? error.cause.message : '',
    error?.code,
    error?.cause?.code
  ].filter(Boolean).join(' ');
  return /timeout|timed out|aborted|econnreset|econnrefused|enotfound|enetunreach|epipe|socket|und_err|fetch failed|network|gateway_header_timeout/i.test(message);
}

export function describeRetryReason(error, status) {
  const code = Number(status);
  if (code === 429) return '网关限流（HTTP 429）';
  if (code === 408) return '网关等待上游响应超时（HTTP 408）';
  if (code === 502 || code === 503 || code === 504) return `网关或上游暂时不可用（HTTP ${code}）`;
  if (code >= 500) return `上游服务错误（HTTP ${code}）`;
  const message = [
    error?.message,
    error?.cause instanceof Error ? error.cause.message : '',
    error?.code
  ].filter(Boolean).join(' ');
  if (/429|rate.?limit/i.test(message)) return '网关限流';
  if (/408|timeout|timed out|etimedout|aborted|gateway_header_timeout|超时/i.test(message)) {
    return '网关等待上游响应超时';
  }
  if (/econnreset|socket hang up/i.test(message)) return '上游连接被重置';
  if (/econnrefused|enotfound/i.test(message)) return '无法连上上游';
  if (/fetch failed|und_err|network/i.test(message)) return '网关到上游的网络中断';
  return String(message || '网关调用失败').slice(0, 160);
}

export function backoffMs(failedAttempt) {
  const index = Math.max(0, Math.floor(Number(failedAttempt) || 1) - 1);
  return BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)];
}

export function headerTimeoutFor({ role, stream }, env = process.env) {
  if (!stream) return NON_STREAM_HEADER_TIMEOUT_MS;
  const override = Number(env.LLM_GATEWAY_HEADER_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return role === 'small' ? STREAM_HEADER_TIMEOUT_MS.small : STREAM_HEADER_TIMEOUT_MS.cloud;
}

let sharedTransport;

export function upstreamFetch(url, init = {}, context = {}) {
  sharedTransport ||= createUpstreamTransport();
  return sharedTransport(url, init, context);
}

export function upstreamRouteState() {
  sharedTransport ||= createUpstreamTransport();
  return sharedTransport.describe();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry connect / TTFB / retryable HTTP failures. Once headers arrive, the
 * caller streams the body; that path is not retried here.
 */
export async function fetchUpstreamWithRetry(url, init = {}, options = {}) {
  const fetchImpl = options.fetch || upstreamFetch;
  const maxRetries = options.maxRetries ?? GATEWAY_MAX_RETRIES;
  const headerTimeoutMs = options.headerTimeoutMs ?? GATEWAY_HEADER_TIMEOUT_MS;
  const clientSignal = init.signal;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    if (clientSignal?.aborted) {
      throw clientSignal.reason instanceof Error ? clientSignal.reason : new Error('aborted');
    }
    const attemptController = new AbortController();
    const headerTimer = setTimeout(() => {
      attemptController.abort(new Error('gateway_header_timeout'));
    }, headerTimeoutMs);
    const signals = [attemptController.signal];
    if (clientSignal) signals.push(clientSignal);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals)
      }, { clientSignal });
      clearTimeout(headerTimer);
      if (isRetryableStatus(response.status) && attempt <= maxRetries) {
        const reason = describeRetryReason(null, response.status);
        lastError = new Error(reason);
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        options.onRetry?.(attempt, reason);
        await delay((options.backoffMs || backoffMs)(attempt));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(headerTimer);
      if (clientSignal?.aborted) throw error;
      lastError = error;
      if (!isRetryableError(error, false) || attempt > maxRetries) throw error;
      const reason = describeRetryReason(error);
      options.onRetry?.(attempt, reason, error);
      await delay((options.backoffMs || backoffMs)(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || '网关调用失败'));
}
