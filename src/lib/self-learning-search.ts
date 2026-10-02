// 【重建】原文件已丢失，按 dist/runtime/api-app.mjs 还原并补回类型。
// 自学习记忆的检索分词：英文按词，中文按相邻两字（bigram），供 PostgreSQL 全文检索使用。

const CJK = /[\u3400-\u9fff]/;

export function learningSearchTokens(text: string): string[] {
  const raw = String(text || '').toLowerCase();
  const tokens: string[] = [];
  for (const word of raw.match(/[a-z0-9][a-z0-9_-]{1,40}/g) || []) {
    tokens.push(word);
  }
  const chars = [...raw].filter((char) => CJK.test(char));
  if (chars.length === 1) tokens.push(chars[0]);
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(`${chars[index]}${chars[index + 1]}`);
  }
  return [...new Set(tokens)];
}

export function learningSearchDocument(input: {
  instruction?: string | null;
  applicability?: string | null;
  domainLabel?: string | null;
  keywords?: string[] | null;
}): string {
  const parts = [input.instruction, input.applicability, input.domainLabel, ...(input.keywords || [])];
  return parts.flatMap((part) => learningSearchTokens(String(part || ''))).join(' ');
}

/** 取最长的 4 个词拼成 to_tsquery 表达式；没有可用词时返回空串 */
export function learningTsQuery(text: string): string {
  const tokens = learningSearchTokens(text)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, 4)
    .filter((token) => /^[a-z0-9_\u3400-\u9fff-]+$/u.test(token));
  if (!tokens.length) return '';
  return tokens.join(' & ');
}
