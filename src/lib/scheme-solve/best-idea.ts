import type { SchemeIdea, SchemeIdeaView, SchemeStage } from './types';

export function isMaximizeGoal(idea: Pick<SchemeIdea, 'title' | 'summary' | 'goal'> | { title?: string; summary?: string; goal?: string }) {
  return /最大|收益|利润|maximize|\bmax\b/i.test(`${idea.goal || ''} ${idea.title || ''} ${idea.summary || ''}`);
}

export function readSolveObjective(artifactJson: unknown): number | null {
  if (!artifactJson || typeof artifactJson !== 'object' || Array.isArray(artifactJson)) return null;
  const record = artifactJson as Record<string, unknown>;
  if (record.kind === 'agent') return null;
  const raw = record.objective ?? record.objective_value;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function stageOf(stages: SchemeStage[], key: SchemeStage['key']) {
  return stages.find((stage) => stage.key === key);
}

export function pickBestSchemeIdea<T extends Pick<SchemeIdeaView, 'id' | 'solvability' | 'title' | 'summary' | 'goal' | 'stages'>>(
  ideas: T[]
): T | undefined {
  const reported = ideas.find((idea) => stageOf(idea.stages, 'report')?.status === 'done');
  if (reported) return reported;

  const solved = ideas.filter(
    (idea) => idea.solvability === 'solvable' && stageOf(idea.stages, 'solve')?.status === 'done'
  );
  if (!solved.length) return undefined;

  const maximize = solved.filter(isMaximizeGoal).length > solved.length / 2;
  return [...solved].sort((left, right) => {
    const leftValue = readSolveObjective(stageOf(left.stages, 'solve')?.artifactJson);
    const rightValue = readSolveObjective(stageOf(right.stages, 'solve')?.artifactJson);
    if (leftValue == null && rightValue == null) return 0;
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    return maximize ? rightValue - leftValue : leftValue - rightValue;
  })[0];
}
