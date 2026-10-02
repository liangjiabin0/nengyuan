/** Labels and targets for agent tool steps shown in the thinking stream. */

function compactText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      const text = compactText(value);
      if (text) return text;
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => (typeof item === 'string' ? compactText(item) : ''))
        .filter(Boolean)
        .join(' / ');
      if (joined) return joined;
    }
  }
  return '';
}

export function isWebSearchTool(tool: string) {
  return /^(web_search|websearch|web-search)$/i.test(tool);
}

export function isWebFetchTool(tool: string) {
  return /^(webfetch|web_fetch|web-fetch)$/i.test(tool);
}

export function webSearchQuery(input: Record<string, unknown> = {}) {
  return firstNonEmpty(
    input.query,
    input.q,
    input.search,
    input.search_query,
    input.searchQuery,
    input.search_queries,
    input.objective,
    input.keyword,
    input.keywords
  );
}

export function webFetchUrl(input: Record<string, unknown> = {}) {
  return firstNonEmpty(input.url, input.uri, input.href, input.link, input.page);
}

export type WebToolSummary = { verb: string; detail: string; wrap?: boolean };

export function summarizeInvalidTool(
  input: Record<string, unknown> = {},
  contentFallback = ''
): WebToolSummary {
  const requestedTool = firstNonEmpty(input.tool, input.toolName, input.function, input.name);
  const error = firstNonEmpty(input.error, input.message, input.reason, contentFallback);
  const target = requestedTool ? `原工具 ${requestedTool}` : '未知工具';
  return {
    verb: '调用失败',
    detail: error ? `${target}；${error}` : target,
    wrap: true
  };
}

export function summarizeWebTool(
  tool: string,
  input: Record<string, unknown> = {},
  contentFallback = ''
): WebToolSummary | null {
  if (isWebSearchTool(tool)) {
    return { verb: '联网检索', detail: webSearchQuery(input) || compactText(contentFallback) };
  }
  if (isWebFetchTool(tool)) {
    return {
      verb: '抓取网页',
      detail: webFetchUrl(input) || compactText(contentFallback),
      wrap: true
    };
  }
  return null;
}

export function formatToolCallContent(tool: string, input: Record<string, unknown>) {
  if (tool === 'invalid') {
    const invalid = summarizeInvalidTool(input);
    return `${invalid.verb}：${invalid.detail}`;
  }
  if (tool === 'question' || tool === 'ask') {
    const headers = Array.isArray(input.questions)
      ? input.questions
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const record = item as Record<string, unknown>;
          return compactText(String(record.header || record.question || record.title || ''));
        })
        .filter(Boolean)
      : [];
    const detail = headers.join(' / ') || firstNonEmpty(input.header, input.question);
    return detail ? `询问：${detail}` : '询问';
  }
  const web = summarizeWebTool(tool, input);
  if (web?.detail) return `${tool}：${web.detail}`;
  if (tool === 'skill') {
    const name = firstNonEmpty(input.name, input.skill, input.id);
    return name ? `skill：${name}` : '调用 skill';
  }
  const target = firstNonEmpty(
    input.path,
    input.filePath,
    input.pattern,
    input.query,
    input.url,
    input.command,
    input.name
  );
  return target ? `${tool}：${target}` : `调用 ${tool}`;
}
