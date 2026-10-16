import type { ChatModelId } from '@/lib/model-ids';
import type { ChatAttachment } from '@/lib/chat-attachments';
import type { SCHEME_STAGE_KEYS } from './constants';

export type SchemeStageKey = (typeof SCHEME_STAGE_KEYS)[number];

export type SchemeSessionStatus =
  | 'draft'
  | 'brainstorming'
  | 'ready'
  | 'researching'
  | 'done'
  | 'failed';

export type SchemeSolvability = 'solvable' | 'rejected';
export type SchemeProblemClass = 'dcopf' | 'lp' | 'mip' | 'mgplan' | 'acopf' | 'dispatch' | 'loss' | 'modelica' | 'forecast';
export type SchemeStageStatus = 'idle' | 'running' | 'done' | 'failed' | 'skipped';
export type SchemeEventLevel = 'info' | 'warn' | 'error' | 'thought' | 'output';

export type SchemeAgentStep = {
  type: 'thought' | 'plan' | 'public_text' | 'tool_call' | 'observation' | 'synthesis';
  step?: number;
  tool?: string;
  content: string;
  durationMs?: number;
  lane?: string;
};

export type SchemeAgentTrace = {
  kind?: 'agent';
  agentName?: string;
  agentUid?: string;
  agentUid2?: string;
  output?: string;
  steps?: SchemeAgentStep[];
};

function readAgentSteps(value: unknown): SchemeAgentStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const type = row.type;
    if (
      type !== 'thought'
      && type !== 'plan'
      && type !== 'public_text'
      && type !== 'tool_call'
      && type !== 'observation'
      && type !== 'synthesis'
    ) return [];
    if (typeof row.content !== 'string' || !row.content.trim()) return [];
    return [{
      type: type as SchemeAgentStep['type'],
      step: typeof row.step === 'number' ? row.step : undefined,
      tool: typeof row.tool === 'string' ? row.tool : undefined,
      content: row.content,
      durationMs: typeof row.durationMs === 'number' ? row.durationMs : undefined,
      lane: typeof row.lane === 'string' ? row.lane : undefined
    }];
  });
  return steps.length ? steps : undefined;
}

export function readStageAgentTrace(stage?: { artifactJson?: unknown } | null): SchemeAgentTrace {
  const raw = stage?.artifactJson;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const steps = readAgentSteps(record.steps);
  if (record.kind !== 'agent' && !record.agentName && !record.agentUid && !record.output && !steps) return {};
  return {
    kind: 'agent',
    agentName: typeof record.agentName === 'string' ? record.agentName : undefined,
    agentUid: typeof record.agentUid === 'string' ? record.agentUid : undefined,
    agentUid2: typeof record.agentUid2 === 'string' ? record.agentUid2 : undefined,
    output: typeof record.output === 'string' ? record.output : undefined,
    steps
  };
}

export type SchemeSessionSource = 'scheme-solve' | 'virtual-sim';

export type SchemeSession = {
  chatModel?: ChatModelId;
  thinkingId?: string;
  id: string;
  title: string;
  seedIdea: string;
  status: SchemeSessionStatus;
  progress: number;
  progressDetail?: string;
  error?: string;
  source?: SchemeSessionSource;
  toolId?: SchemeProblemClass;
  createdAt: string;
  updatedAt: string;
};

export type SchemeIdea = {
  id: string;
  sessionId: string;
  parentId: string | null;
  title: string;
  summary: string;
  solvability: SchemeSolvability;
  rejectReason?: string;
  problemClass?: SchemeProblemClass;
  decisions?: string;
  limits?: string;
  goal?: string;
  caseHint?: string;
  whySolvable?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type SchemeStage = {
  id: string;
  sessionId: string;
  ideaId: string;
  key: SchemeStageKey;
  status: SchemeStageStatus;
  headline: string;
  detail?: string;
  artifactJson?: unknown;
  updatedAt: string;
};

export type SchemeEvent = {
  id: number;
  sessionId: string;
  ideaId?: string;
  stage?: SchemeStageKey | 'brainstorm' | 'session';
  level: SchemeEventLevel;
  text: string;
  createdAt: string;
};

export type SchemeIdeaView = SchemeIdea & {
  stages: SchemeStage[];
};

export type SchemeSessionSnapshot = SchemeSession & {
  ideas: SchemeIdeaView[];
  events: SchemeEvent[];
  attachments?: ChatAttachment[];
};

export type SchemeBrainstormIdea = {
  title: string;
  summary: string;
  problemClass: SchemeProblemClass;
  decisions: string;
  limits: string;
  goal: string;
  caseHint?: string;
  whySolvable: string;
};

export type SchemeBrainstormRejected = {
  title: string;
  reason: string;
};

export type SchemeBrainstormPayload = {
  ideas: SchemeBrainstormIdea[];
  rejected: SchemeBrainstormRejected[];
};
