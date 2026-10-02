import fs from 'node:fs';
import path from 'node:path';

export const ESOPT_SKILL_NAME = 'esopt';
export const ESOPT_AGENT_NAME = 'esopt-mcp';
export const ESOPT_TOOL_PREFIX = 'esopt_';
export const ESOPT_UNLOCK_FLAG = '.esopt-skill-unlocked';

type ToolBeforeInput = {
  tool: string;
};

type ToolBeforeOutput = {
  args: Record<string, unknown>;
};

type ToolAfterInput = {
  tool: string;
  args?: Record<string, unknown>;
};

function namedArg(args: Record<string, unknown> | undefined, names: string[]) {
  for (const name of names) {
    const value = String(args?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function skillNameFromArgs(args: Record<string, unknown> | undefined) {
  return namedArg(args, ['name', 'skill', 'id']);
}

export function taskAgentFromArgs(args: Record<string, unknown> | undefined) {
  return namedArg(args, ['subagent_type', 'agent', 'subagent']);
}

export function esoptUnlockPath(directory: string) {
  return path.join(directory, ESOPT_UNLOCK_FLAG);
}

export function unlockEsopt(directory: string) {
  const root = String(directory || '').trim();
  if (!root) return;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(esoptUnlockPath(root), '1');
}

export function isEsoptUnlocked(directory: string) {
  const root = String(directory || '').trim();
  return Boolean(root) && fs.existsSync(esoptUnlockPath(root));
}

function needsEsoptUnlock(tool: string, args: Record<string, unknown> | undefined) {
  return tool.startsWith(ESOPT_TOOL_PREFIX)
    || (tool === 'task' && taskAgentFromArgs(args) === ESOPT_AGENT_NAME);
}

export const createMcpSkillGate = async ({ directory }: { directory: string }) => ({
  'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
    if (input.tool === 'skill' && skillNameFromArgs(output.args) === ESOPT_SKILL_NAME) {
      unlockEsopt(directory);
      return;
    }
    if (!needsEsoptUnlock(input.tool, output.args) || isEsoptUnlocked(directory)) return;
    throw new Error('请先调用 skill 加载 esopt，再派发 esopt-mcp 子 Agent。父 Agent 不直接加载 MCP 工具。');
  },
  'tool.execute.after': async (input: ToolAfterInput) => {
    if (input.tool !== 'skill' || skillNameFromArgs(input.args) !== ESOPT_SKILL_NAME) return;
    unlockEsopt(directory);
  }
});
