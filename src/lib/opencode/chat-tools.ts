import type { OpenCodeToolFlags } from './types';

/** 智能对话：OpenCode sidecar 已接入的工具全部放开。 */
export const CHAT_TOOL_POLICY = {
  read: true,
  list: true,
  glob: true,
  grep: true,
  bash: true,
  edit: true,
  write: true,
  task: true,
  webfetch: true,
  websearch: true,
  todowrite: true,
  skill: true,
  lsp: true,
  question: false
} as const satisfies Required<OpenCodeToolFlags>;
