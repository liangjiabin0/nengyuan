import {
  composeAssistantReply,
  composeUserBrief,
  type InspectorTraceItem,
  type SchemeArtifactFiles,
  type SchemeLiveTraceItem
} from '@/lib/scheme-solve/agent-trace';
import { SCHEME_STAGE_LABELS } from '@/lib/scheme-solve/constants';
import {
  readStageAgentTrace,
  type SchemeAgentStep,
  type SchemeEvent,
  type SchemeIdeaView,
  type SchemeSessionSnapshot,
  type SchemeStageKey
} from '@/lib/scheme-solve/types';
import { getVirtualSimTool } from './tools';

export type VirtualSimTurn = {
  user: string;
  timeline: InspectorTraceItem[];
  reply: string;
  running: boolean;
  runningHint?: string;
  error?: string;
};

const OPS_EVENT = /开始研究|同步附件|附件虚拟目录|已进入求解队列|正在启动|并发 \d/;

function stageOf(idea: SchemeIdeaView | undefined, key: SchemeStageKey) {
  return idea?.stages.find((stage) => stage.key === key);
}

function fromAgentStep(step: SchemeAgentStep, key: SchemeStageKey, index: number): InspectorTraceItem | null {
  const content = String(step.content || '').trim();
  if (!content) return null;
  if (step.type === 'tool_call') {
    return {
      id: `${key}:tool:${step.step ?? index}:${index}`,
      kind: 'tool',
      label: step.tool || SCHEME_STAGE_LABELS[key],
      body: content,
      durationMs: step.durationMs,
      lane: step.lane
    };
  }
  if (step.type === 'thought' || step.type === 'plan') {
    return {
      id: `${key}:${step.type}:${step.step ?? index}:${index}`,
      kind: step.type,
      label: step.type === 'plan' ? '步骤规划' : '内部推理',
      body: content,
      durationMs: step.durationMs,
      lane: step.lane
    };
  }
  return null;
}

function fromThoughtEvent(event: SchemeEvent): InspectorTraceItem | null {
  const text = String(event.text || '').trim();
  if (!text || OPS_EVENT.test(text)) return null;
  if (event.level === 'thought') {
    return {
      id: `event:${event.id}`,
      kind: 'thought',
      label: '内部推理',
      body: text.replace(/^\[(thought|plan)\]\s*/, ''),
      time: event.createdAt
    };
  }
  const tagged = text.match(/^\[(thought|plan)\]\s*([\s\S]+)$/);
  if (!tagged) return null;
  return {
    id: `event:${event.id}`,
    kind: tagged[1] === 'plan' ? 'plan' : 'thought',
    label: tagged[1] === 'plan' ? '步骤规划' : '内部推理',
    body: tagged[2].trim(),
    time: event.createdAt
  };
}

function fromLive(item: SchemeLiveTraceItem): InspectorTraceItem | null {
  const text = String(item.text || '').trim();
  if (!text || OPS_EVENT.test(text)) return null;
  if (item.kind !== 'thought' && item.kind !== 'plan' && item.kind !== 'tool') return null;
  return {
    id: item.key,
    kind: item.kind,
    label: item.kind === 'tool' ? `工具 · ${item.tool || 'call'}` : item.kind === 'plan' ? '步骤规划' : '内部推理',
    body: text
  };
}

function dedupeTimeline(items: InspectorTraceItem[]) {
  const unique: InspectorTraceItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const body = item.body.replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const key = `${item.kind}:${body.slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.map((item, index) => ({ ...item, id: `${item.id}:${index}` }));
}

export function composeVirtualSimTurn(
  session: SchemeSessionSnapshot,
  artifact: SchemeArtifactFiles | null,
  liveTrace: SchemeLiveTraceItem[]
): VirtualSimTurn {
  const idea = session.ideas[0];
  const tool = session.toolId ? getVirtualSimTool(session.toolId) : null;
  const running = session.status === 'researching'
    || session.status === 'brainstorming'
    || (session.source === 'virtual-sim' && session.status === 'draft' && (session.progress || 0) > 0);
  const events = session.events || [];
  const designTrace = readStageAgentTrace(stageOf(idea, 'design'));
  const reviewTrace = readStageAgentTrace(stageOf(idea, 'review'));
  const writeTrace = readStageAgentTrace(stageOf(idea, 'write'));

  const timeline = dedupeTimeline([
    ...(designTrace.steps || []).flatMap((step, index) => {
      const item = fromAgentStep(step, 'design', index);
      return item ? [item] : [];
    }),
    ...events.flatMap((event) => {
      const item = fromThoughtEvent(event);
      return item ? [item] : [];
    }),
    ...(reviewTrace.steps || []).flatMap((step, index) => {
      const item = fromAgentStep(step, 'review', index);
      return item ? [item] : [];
    }),
    ...(writeTrace.steps || []).flatMap((step, index) => {
      const item = fromAgentStep(step, 'write', index);
      return item ? [item] : [];
    }),
    ...(running ? liveTrace : []).flatMap((item) => {
      const next = fromLive(item);
      return next ? [next] : [];
    })
  ]);

  const reportDone = Boolean(artifact?.report || stageOf(idea, 'report')?.status === 'done');
  const reply = !running && reportDone
    ? composeAssistantReply({
        kind: 'stage',
        stageKey: 'write',
        session,
        idea,
        artifact,
        trace: writeTrace,
        running
      })
    : '';

  const user = [
    `# 任务`,
    `在「${tool?.label || '虚拟仿真'}」工作台中单独运行求解器工具，不要再做头脑风暴分叉。`,
    '',
    '## 用户描述',
    session.seedIdea,
    '',
    '## 交付',
    ...composeUserBrief({ kind: 'stage', stageKey: 'design', session, idea }).split('\n').slice(-6)
  ].join('\n');

  const errorEvent = [...events].reverse().find((event) => event.level === 'error');
  const runningStage = idea?.stages.find((stage) => stage.status === 'running');
  return {
    user,
    timeline,
    reply,
    running,
    runningHint: session.progressDetail
      || runningStage?.headline
      || (timeline.at(-1)?.body.slice(0, 80))
      || `${tool?.engine || '求解器'} 正在思考…`,
    error: session.status === 'failed' ? session.error || errorEvent?.text : errorEvent?.text
  };
}
