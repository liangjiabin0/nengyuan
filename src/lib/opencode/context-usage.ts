import type { ModelContextUsage } from './types';

export type OpenCodeTokenUsage = {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    read?: number;
    write?: number;
  };
};

function nonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** True when the UI/API can treat this as a recognized occupancy reading. */
export function hasRecognizedContextUsage(usage?: Partial<ModelContextUsage> | null): usage is ModelContextUsage {
  return Boolean(usage && typeof usage.contextTokens === 'number' && usage.contextTokens > 0);
}

/**
 * Occupancy after the latest model round.
 * OpenCode `tokens.total` is input + output + reasoning + cache.read when the
 * provider reports usage; vLLM streams often omit it and leave every field at 0.
 */
export function contextTokensFromOpenCodeTokens(tokens?: OpenCodeTokenUsage | null) {
  if (!tokens) return undefined;
  const occupied = Math.max(
    nonNegative(tokens.total),
    nonNegative(tokens.cache?.read)
      + nonNegative(tokens.cache?.write)
      + nonNegative(tokens.input)
      + nonNegative(tokens.output)
      + nonNegative(tokens.reasoning)
  );
  return occupied > 0 ? occupied : undefined;
}

export function compactContextUsage(usage?: Partial<ModelContextUsage> | null): ModelContextUsage | undefined {
  if (!hasRecognizedContextUsage(usage)) return undefined;
  return {
    contextTokens: usage.contextTokens,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    modelRounds: usage.modelRounds || 0,
    ...(usage.compactionCount ? { compactionCount: usage.compactionCount } : {}),
    ...(usage.compacted ? { compacted: true } : {})
  };
}

export function contextUsageFromMetrics(metrics?: Partial<ModelContextUsage>) {
  return compactContextUsage(metrics);
}

export function modelContextUsageFromRounds(rounds: OpenCodeTokenUsage[]): ModelContextUsage | null {
  let promptTokens = 0;
  let completionTokens = 0;
  let latestOccupied: number | undefined;
  for (const tokens of rounds) {
    promptTokens += nonNegative(tokens.input);
    completionTokens += nonNegative(tokens.output) + nonNegative(tokens.reasoning);
    const occupied = contextTokensFromOpenCodeTokens(tokens);
    if (occupied != null) latestOccupied = occupied;
  }
  if (latestOccupied == null) return null;
  return {
    contextTokens: latestOccupied,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    modelRounds: rounds.length
  };
}
