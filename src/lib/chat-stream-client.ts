import { isInFlightAssistantMessage } from '@/lib/chat-active-session';

export const NETWORK_DISCONNECT_MESSAGE =
  '实时连接已中断。服务端可能仍在生成，请稍后从左侧会话点开查看；不要立刻重发同一问题，以免打断仍在进行的检索。';

const NETWORK_DISCONNECT_RE =
  /failed to fetch|networkerror|network error|load failed|err_network|err_connection|econnreset|etimedout|enotfound|und_err_socket|fetch failed|incomplete chunked|networkerror when attempting to fetch|网络异常|网络请求失败|连接.*中断|回答未完整接收/i;

export function errorText(err: unknown) {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? err.cause.message : '';
    return [err.message, cause].filter(Boolean).join(' ');
  }
  return String(err || '');
}

export function isNetworkDisconnectError(err: unknown) {
  const message = errorText(err).trim();
  if (!message) return false;
  return NETWORK_DISCONNECT_RE.test(message) || /^network$/i.test(message);
}

export function normalizeStreamError(err: unknown) {
  const message = errorText(err) || '查询失败';
  if (isNetworkDisconnectError(message)) return NETWORK_DISCONNECT_MESSAGE;
  if (/aborted|abort/i.test(message) && !/取消|停止/.test(message)) {
    return '请求已中断。';
  }
  return message || '查询失败';
}

export function lastUserMessageContent(messages: Array<{ role?: string; content?: string }>) {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return String(last?.content || '').trim();
}

export function shouldReuseActiveGeneration(input: {
  question: string;
  generating: boolean;
  messages: Array<{ role?: string; content?: string }>;
}) {
  if (!input.generating) return false;
  const question = input.question.trim();
  if (!question) return false;
  return lastUserMessageContent(input.messages) === question;
}

export function classifyDisconnectedChatRun(input: {
  generating: boolean;
  messages: Array<{ role?: string; inProgress?: boolean; content?: string }>;
}): 'resume' | 'complete' | 'failed' {
  if (input.generating || input.messages.some((message) => isInFlightAssistantMessage(message))) {
    return 'resume';
  }
  const lastAssistant = [...input.messages].reverse().find((message) => message.role === 'assistant');
  const content = String(lastAssistant?.content || '').trim();
  if (!content) return 'failed';
  if (/抱歉，查询失败/.test(content) && isNetworkDisconnectError(content)) return 'failed';
  return 'complete';
}

export async function fetchConversationRunState(apiBase: string, conversationId: string) {
  const response = await fetch(`${apiBase}/conversations/${encodeURIComponent(conversationId)}`);
  const data = await response.json().catch(() => ({})) as {
    generating?: boolean;
    messages?: unknown[];
  };
  if (!response.ok) return null;
  return {
    generating: data.generating === true,
    messages: Array.isArray(data.messages) ? data.messages : []
  };
}
