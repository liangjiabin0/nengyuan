const SESSION_ID_RE = /ses_[A-Za-z0-9]+/g;
const WORD_REPEAT_RE = /([A-Za-z\u4e00-\u9fff]{2,24})(?:\s+\1){23,}/;
const CHAR_REPEAT_RE = /(.)\1{47,}/;
const NGRAM_REPEAT_RE = /(.{4,12})\1{12,}/;

export const COLLAPSE_REPEAT_THRESHOLD = 24;
export const THINKING_COMPLETION_CAP = 8_192;

export function detectTokenCollapse(text: string) {
  const value = String(text || '');
  if (!value) return { collapsed: false as const };
  if (CHAR_REPEAT_RE.test(value) || NGRAM_REPEAT_RE.test(value) || WORD_REPEAT_RE.test(value)) {
    return { collapsed: true as const };
  }
  return { collapsed: false as const };
}

export function lastStablePrefix(text: string) {
  const value = String(text || '');
  const word = value.match(WORD_REPEAT_RE);
  if (word && word.index != null) return value.slice(0, word.index).trimEnd();
  const ngram = value.match(NGRAM_REPEAT_RE);
  if (ngram && ngram.index != null) return value.slice(0, ngram.index).trimEnd();
  const chars = value.match(CHAR_REPEAT_RE);
  if (chars && chars.index != null) return value.slice(0, chars.index).trimEnd();
  return value;
}

export function applyCollapseGuard(text: string) {
  const collapsed = detectTokenCollapse(text).collapsed;
  if (!collapsed) return { text, collapsed: false as const };
  const prefix = lastStablePrefix(text);
  return { text: prefix, collapsed: true as const };
}

export function extractOpenCodeSessionIds(value: unknown) {
  const ids = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(SESSION_ID_RE)) ids.add(match[0]);
      return;
    }
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
      if (/session/i.test(key) && typeof nested === 'string' && SESSION_ID_RE.test(nested)) {
        ids.add(nested.match(SESSION_ID_RE)?.[0] || nested);
      }
      visit(nested);
    }
  };
  visit(value);
  return [...ids];
}

export function capThinkingMaxTokens(current?: number | null) {
  if (current == null || current < 512) return 4096;
  return Math.min(current, THINKING_COMPLETION_CAP);
}
