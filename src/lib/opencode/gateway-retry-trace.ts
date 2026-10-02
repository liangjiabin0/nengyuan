/** 与 scripts/llm-gateway-retry.mjs 的 GATEWAY_MAX_RETRIES 保持一致。 */
export const GATEWAY_RETRY_MAX_ATTEMPTS = 3;

export function isTimeoutLikeError(message: string) {
  return /timeout|timed out|timedout|etimedout|aborted|gateway_header_timeout|网关.*超时|无响应|超时|econnreset|econnrefused|socket hang up|fetch failed|und_err|502|503|504|408|429/i.test(
    String(message || '')
  );
}

export function describeOpenCodeRetryReason(message: string) {
  const text = String(message || '').trim();
  if (/429|rate.?limit|too many/i.test(text)) return '网关限流';
  if (/408|timeout|timed out|etimedout|aborted|gateway_header_timeout|超时|无响应/i.test(text)) {
    return '网关等待上游响应超时';
  }
  if (/502|503|504|bad gateway|unavailable/i.test(text)) return '网关或上游暂时不可用';
  if (/econnreset|socket hang up/i.test(text)) return '上游连接被重置';
  if (/econnrefused|enotfound/i.test(text)) return '无法连上上游';
  if (/fetch failed|und_err|network|econn/i.test(text)) return '网关连接被中断';
  return text.slice(0, 120) || '网关调用失败';
}

export function formatGatewayRetryThought(input: {
  attempt: number;
  maxAttempts?: number;
  reason: string;
  tool?: string;
}) {
  const maxAttempts = input.maxAttempts ?? GATEWAY_RETRY_MAX_ATTEMPTS;
  const attempt = Math.max(1, Math.min(maxAttempts, Math.floor(input.attempt) || 1));
  const who = input.tool?.trim() ? `工具「${input.tool}」` : '这次模型调用';
  return `${who}中断：${input.reason}。正在通过网关重新连接（第 ${attempt}/${maxAttempts} 次）。`;
}

export function summarizeGatewayRetryThought(content: string) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text.includes('正在通过网关重新连接')) return null;
  return { verb: '重连', detail: text };
}
