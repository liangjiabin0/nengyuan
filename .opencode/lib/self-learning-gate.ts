import fs from 'node:fs';
import path from 'node:path';

export const SELF_LEARNING_SKILL_NAME = 'self-learning';
export const SELF_LEARNING_TOOL_NAME = 'save_learning_memory';
export const SELF_LEARNING_UNLOCK_FLAG = '.self-learning-unlocked';

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

export function skillNameFromArgs(args: Record<string, unknown> | undefined) {
  return String(args?.name || args?.skill || args?.id || '').trim();
}

export function isSelfLearningSkill(name: string) {
  return name === SELF_LEARNING_SKILL_NAME;
}

export function selfLearningUnlockPath(directory: string) {
  return path.join(directory, SELF_LEARNING_UNLOCK_FLAG);
}

export function unlockSelfLearning(directory: string) {
  const root = String(directory || '').trim();
  if (!root) return;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(selfLearningUnlockPath(root), '1');
}

export function isSelfLearningUnlocked(directory: string) {
  const root = String(directory || '').trim();
  return Boolean(root) && fs.existsSync(selfLearningUnlockPath(root));
}

export const createSelfLearningGate = async ({ directory }: { directory: string }) => ({
  'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
    if (input.tool === 'skill' && isSelfLearningSkill(skillNameFromArgs(output.args))) {
      unlockSelfLearning(directory);
      return;
    }
    if (input.tool !== SELF_LEARNING_TOOL_NAME) return;
    if (isSelfLearningUnlocked(directory)) return;
    throw new Error('请先调用 skill 加载 self-learning，再保存或查看私有记忆。');
  },
  'tool.execute.after': async (input: ToolAfterInput) => {
    if (input.tool !== 'skill') return;
    if (!isSelfLearningSkill(skillNameFromArgs(input.args))) return;
    unlockSelfLearning(directory);
  }
});
