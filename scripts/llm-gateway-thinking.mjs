/** Shared thinking-off rules for the local LLM gateway. */

export function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'string' ? part : String(part?.text || part?.content || ''))
    .join('\n');
}

/**
 * Only the finalizer must stay think-off. Execution subagents (general / esopt-mcp)
 * now run with Arc thinking; do not match their system prompts here.
 */
export function forcesThinkingOff(parsed) {
  return Array.isArray(parsed?.messages) && parsed.messages.some((message) => (
    message?.role === 'system'
    && /你是最终答复恢复器/.test(messageText(message.content))
  ));
}
