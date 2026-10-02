import type { RuntimeAgentStep } from './types';

function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Stable identity is separate from event order so a growing thought can move without duplicating. */
export function isSameRuntimeAgentStep(left: RuntimeAgentStep, right: RuntimeAgentStep) {
  const originConflict = (
    Boolean(left.sessionId && right.sessionId && left.sessionId !== right.sessionId)
    || Boolean(
      left.parentToolCallId
      && right.parentToolCallId
      && left.parentToolCallId !== right.parentToolCallId
    )
  );
  if (originConflict || left.type !== right.type) return false;
  if (left.step === right.step) return true;
  return Boolean(
    right.toolCallId
    && left.toolCallId === right.toolCallId
  );
}

export function runtimeAgentStepOrder(step: RuntimeAgentStep) {
  return validSequence(step.sequence) ? step.sequence : step.step;
}

/** Return a stable, non-mutating display sort. */
export function sortRuntimeAgentSteps<T extends RuntimeAgentStep>(steps: readonly T[]): T[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((left, right) => (
      runtimeAgentStepOrder(left.step) - runtimeAgentStepOrder(right.step)
      || left.index - right.index
    ))
    .map(({ step }) => step);
}

/**
 * Upsert one streamed node, preserving its stable identity while honoring its
 * newest meaningful event order. Identical replays enrich metadata but do not
 * make an old node jump to the end of the transcript.
 */
export function mergeRuntimeAgentStep(
  current: readonly RuntimeAgentStep[],
  incoming: RuntimeAgentStep
) {
  const previous = current.find((step) => isSameRuntimeAgentStep(step, incoming));
  if (!previous) return sortRuntimeAgentSteps([...current, incoming]);

  if (
    validSequence(previous.sequence)
    && validSequence(incoming.sequence)
    && incoming.sequence < previous.sequence
  ) {
    return sortRuntimeAgentSteps(current);
  }

  const sameContent = previous.content === incoming.content;
  const merged: RuntimeAgentStep = { ...previous, ...incoming };
  if (sameContent && validSequence(previous.sequence)) {
    merged.sequence = previous.sequence;
  } else if (!validSequence(incoming.sequence) && validSequence(previous.sequence)) {
    merged.sequence = previous.sequence;
  }

  return sortRuntimeAgentSteps([
    ...current.filter((step) => !isSameRuntimeAgentStep(step, incoming)),
    merged
  ]);
}
