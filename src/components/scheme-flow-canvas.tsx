'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type CoordinateExtent,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { pickBestSchemeIdea } from '@/lib/scheme-solve/best-idea';
import {
  SCHEME_IDEA_AGENT_NODES,
  SCHEME_SHARED_AGENT_NODES,
  type SchemeAgentNodeKey
} from '@/lib/scheme-solve/constants';
import {
  readStageAgentTrace,
  type SchemeEvent,
  type SchemeIdeaView,
  type SchemeSessionSnapshot,
  type SchemeStage,
  type SchemeStageKey,
  type SchemeStageStatus
} from '@/lib/scheme-solve/types';
import { cn } from '@/lib/utils';

export type SchemeCanvasSelection = {
  kind: 'root' | 'idea' | 'stage';
  ideaId?: string;
  stageKey?: SchemeStageKey;
  title: string;
  headline: string;
  detail?: string;
};

type StageNodeData = {
  label: string;
  title: string;
  uid?: string;
  output?: string;
  headline: string;
  status: SchemeStageStatus | 'root';
  rejected?: boolean;
  best?: boolean;
  selection: SchemeCanvasSelection;
};

const NODE_TYPES = { stage: StageCard };

const NODE_W = 200;
const NODE_H_COMPACT = 86;
const NODE_H_EXPANDED = 118;
const GAP_X = 36;
const GAP_Y = 188;
const TRANSLATE_EXTENT_PAD_MIN = 260;
const TRANSLATE_EXTENT_PAD_RATIO = 0.22;
const INFINITE_EXTENT: CoordinateExtent = [
  [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
];

function graphTranslateExtent(nodes: Node<StageNodeData>[]): CoordinateExtent {
  if (nodes.length === 0) return INFINITE_EXTENT;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const width = node.measured?.width ?? node.width ?? NODE_W;
    const height = node.measured?.height ?? node.height ?? (node.data.output ? NODE_H_EXPANDED : NODE_H_COMPACT);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  if (!Number.isFinite(minX)) return INFINITE_EXTENT;
  const padX = Math.max(TRANSLATE_EXTENT_PAD_MIN, (maxX - minX) * TRANSLATE_EXTENT_PAD_RATIO);
  const padY = Math.max(TRANSLATE_EXTENT_PAD_MIN, (maxY - minY) * TRANSLATE_EXTENT_PAD_RATIO);
  return [
    [minX - padX, minY - padY],
    [maxX + padX, maxY + padY]
  ];
}

function statusClass(status: StageNodeData['status'], rejected?: boolean) {
  if (rejected) return 'border-border bg-muted/50 text-muted-foreground';
  if (status === 'running') return 'border-primary bg-primary/5 text-foreground';
  if (status === 'done') return 'border-emerald-400/70 bg-emerald-50 text-foreground';
  if (status === 'failed') return 'border-destructive/60 bg-destructive/5 text-foreground';
  if (status === 'root') return 'border-foreground/20 bg-card text-foreground';
  return 'border-border bg-card text-foreground';
}

function minimapNodeColor(node: Node<StageNodeData>) {
  const data = node.data;
  if (data.rejected) return '#94a3b8';
  if (data.status === 'running') return '#60a5fa';
  if (data.status === 'done') return '#6ee7b7';
  if (data.status === 'failed') return '#fca5a5';
  if (data.status === 'root') return '#64748b';
  return '#94a3b8';
}

function StageCard({ data, selected }: NodeProps<Node<StageNodeData>>) {
  return (
    <div
      className={cn(
        'w-[200px] rounded-lg border px-3 py-2 shadow-none',
        data.output ? 'min-h-[118px]' : 'min-h-[86px]',
        statusClass(data.status, data.rejected),
        selected && 'ring-2 ring-primary/40'
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-border !bg-muted-foreground" />
      <div className="text-[10px] tracking-wide text-muted-foreground">{data.label}</div>
      <div className="mt-0.5 truncate text-sm font-medium">
        {data.best ? '最优 · ' : ''}
        {data.title}
      </div>
      {data.uid ? (
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{data.uid}</div>
      ) : null}
      {data.output ? (
        <div className="mt-1.5 line-clamp-4 text-[10px] leading-4 text-muted-foreground">{data.output}</div>
      ) : (
        <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{data.headline}</div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-border !bg-muted-foreground" />
    </div>
  );
}

function stageOf(stages: SchemeStage[], key: SchemeStageKey) {
  return stages.find((stage) => stage.key === key);
}

function rollupDesigner(stages: SchemeStage[]): SchemeStageStatus {
  const design = stageOf(stages, 'design');
  const model = stageOf(stages, 'model');
  const solve = stageOf(stages, 'solve');
  if ([design, model, solve].some((item) => item?.status === 'running')) return 'running';
  if (solve?.status === 'failed' || design?.status === 'failed') return 'failed';
  if (solve?.status === 'done') return 'done';
  return design?.status || 'idle';
}

function rollupWriter(stages: SchemeStage[]): SchemeStageStatus {
  const write = stageOf(stages, 'write');
  const report = stageOf(stages, 'report');
  if (write?.status === 'running' || report?.status === 'running') return 'running';
  if (report?.status === 'done') return 'done';
  if (write?.status === 'failed' || report?.status === 'failed') return 'failed';
  return write?.status || 'idle';
}

function agentStatus(key: SchemeAgentNodeKey, stages: SchemeStage[]): SchemeStageStatus {
  if (key === 'design') return rollupDesigner(stages);
  if (key === 'write') return rollupWriter(stages);
  return stageOf(stages, 'review')?.status || 'idle';
}

function formatUids(primary?: string, secondary?: string) {
  return [primary, secondary].filter(Boolean).join(' · ');
}

function recoverUids(events: SchemeEvent[], ideaId: string | undefined, stageKey: SchemeStageKey) {
  const found: string[] = [];
  for (const event of events) {
    if (ideaId && event.ideaId !== ideaId) continue;
    if (event.stage !== stageKey && !(stageKey === 'design' && (event.stage === 'model' || event.stage === 'solve'))) {
      continue;
    }
    const matches = event.text.match(/ses_[A-Za-z0-9]+/g) || [];
    for (const match of matches) {
      if (!found.includes(match)) found.push(match);
    }
  }
  return found;
}

function agentNodeData(
  agent: { key: SchemeAgentNodeKey; agent: string; label: string },
  idea: SchemeIdeaView | undefined,
  events: SchemeEvent[],
  extras?: { headline?: string; best?: boolean }
): StageNodeData {
  const stage = idea ? stageOf(idea.stages, agent.key) : undefined;
  const trace = readStageAgentTrace(stage);
  const recovered = recoverUids(events, idea?.id, agent.key);
  const uid = formatUids(trace.agentUid || recovered[0], trace.agentUid2 || recovered[1]);
  const status = idea ? agentStatus(agent.key, idea.stages) : 'idle';
  const fallbackOutput =
    agent.key === 'design'
      ? stageOf(idea?.stages || [], 'solve')?.headline || stage?.headline
      : agent.key === 'write'
        ? stageOf(idea?.stages || [], 'report')?.headline || stage?.headline
        : stage?.headline;
  const output = (trace.output || (status === 'done' ? fallbackOutput : '') || '').trim();
  return {
    label: agent.agent,
    title: agent.label,
    uid: uid || undefined,
    output: output || undefined,
    headline: stage?.headline || extras?.headline || '等待开始',
    status,
    best: extras?.best,
    selection: {
      kind: 'stage',
      ideaId: idea?.id,
      stageKey: agent.key,
      title: `${agent.label}${uid ? ` · ${uid}` : ''}`,
      headline: output || extras?.headline || stage?.headline || '',
      detail: stage?.detail
    }
  };
}

export function buildSchemeFlow(session: SchemeSessionSnapshot): { nodes: Node<StageNodeData>[]; edges: Edge[] } {
  const solvable = session.ideas.filter((idea) => idea.solvability === 'solvable');
  const rejected = session.ideas.filter((idea) => idea.solvability === 'rejected');
  const rows = [...solvable, ...rejected];
  const midY = Math.max(0, (Math.max(rows.length, 1) - 1) * GAP_Y) / 2;
  const winner = pickBestSchemeIdea(solvable);

  const nodes: Node<StageNodeData>[] = [
    {
      id: 'root',
      type: 'stage',
      position: { x: 16, y: midY },
      data: {
        label: '构想',
        title: '原始构想',
        headline: session.seedIdea,
        status: 'root',
        selection: { kind: 'root', title: '原始构想', headline: session.seedIdea }
      }
    }
  ];
  const edges: Edge[] = [];
  const designerIds: string[] = [];

  rows.forEach((idea, row) => {
    const y = row * GAP_Y;
    const ideaNodeId = `idea:${idea.id}`;
    nodes.push({
      id: ideaNodeId,
      type: 'stage',
      position: { x: 240, y },
      data: {
        label: idea.solvability === 'rejected' ? '不可研究' : '想法',
        title: idea.title,
        headline: idea.solvability === 'rejected' ? idea.rejectReason || idea.summary : idea.summary,
        status: idea.solvability === 'rejected' ? 'skipped' : 'done',
        rejected: idea.solvability === 'rejected',
        best: winner?.id === idea.id,
        selection: {
          kind: 'idea',
          ideaId: idea.id,
          stageKey: 'idea',
          title: idea.title,
          headline: idea.rejectReason || idea.summary
        }
      }
    });
    edges.push({ id: `e-root-${idea.id}`, source: 'root', target: ideaNodeId });
    if (idea.solvability === 'rejected') return;

    const designer = SCHEME_IDEA_AGENT_NODES[0];
    const designerId = `agent:${idea.id}:${designer.key}`;
    designerIds.push(designerId);
    nodes.push({
      id: designerId,
      type: 'stage',
      position: { x: 240 + (NODE_W + GAP_X), y },
      data: agentNodeData(designer, idea, session.events, { best: winner?.id === idea.id })
    });
    edges.push({
      id: `e-${idea.id}-idea-design`,
      source: ideaNodeId,
      target: designerId
    });
  });

  SCHEME_SHARED_AGENT_NODES.forEach((agent, index) => {
    const id = `shared:${agent.key}`;
    const waiting =
      agent.key === 'review'
        ? '各想法求解完成后，只审查最优方案一次'
        : '审查完成后撰写最优方案报告';
    nodes.push({
      id,
      type: 'stage',
      position: { x: 240 + (index + 2) * (NODE_W + GAP_X), y: midY },
      data: agentNodeData(agent, winner, session.events, { headline: waiting })
    });
    if (index === 0) {
      for (const designerId of designerIds) {
        edges.push({
          id: `e-${designerId}-review`,
          source: designerId,
          target: id
        });
      }
    } else {
      edges.push({
        id: `e-shared-${SCHEME_SHARED_AGENT_NODES[index - 1]!.key}-${agent.key}`,
        source: `shared:${SCHEME_SHARED_AGENT_NODES[index - 1]!.key}`,
        target: id
      });
    }
  });

  return { nodes, edges };
}

function graphContentKey(session: SchemeSessionSnapshot) {
  return [
    session.id,
    session.seedIdea,
    session.ideas
      .map((idea) => {
        const stages = idea.stages
          .map((stage) => {
            const trace = readStageAgentTrace(stage);
            return [stage.key, stage.status, stage.headline, trace.agentUid, trace.output || ''].join(':');
          })
          .join(';');
        return `${idea.id}:${idea.solvability}:${idea.title}:${stages}`;
      })
      .join('|')
  ].join('//');
}

function structureKey(session: SchemeSessionSnapshot) {
  return session.ideas.map((idea) => `${idea.id}:${idea.solvability}`).join(',');
}

function FitWhenGraphSettles({ sessionId, signature }: { sessionId: string; signature: string }) {
  const { fitView } = useReactFlow();
  const last = useRef('');
  useEffect(() => {
    const key = `${sessionId}:${signature}`;
    if (last.current === key) return;
    last.current = key;
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 200 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sessionId, signature, fitView]);
  return null;
}

function SchemeFlowInner({
  session,
  onSelect
}: {
  session: SchemeSessionSnapshot;
  onSelect: (selection: SchemeCanvasSelection) => void;
}) {
  const contentKey = graphContentKey(session);
  const graph = useMemo(() => buildSchemeFlow(session), [contentKey]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const translateExtent = useMemo(() => graphTranslateExtent(nodes), [nodes]);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      fitViewOptions={{ padding: 0.2 }}
      translateExtent={translateExtent}
      minZoom={0.35}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        const data = node.data as StageNodeData;
        onSelect(data.selection);
      }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      style={{ width: '100%', height: '100%' }}
    >
      <FitWhenGraphSettles sessionId={session.id} signature={structureKey(session)} />
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        className="scheme-minimap"
        bgColor="#eef2f6"
        nodeColor={minimapNodeColor}
        nodeStrokeColor="#94a3b8"
        nodeStrokeWidth={1.2}
        maskColor="rgb(15 23 42 / 0.12)"
        maskStrokeColor="#94a3b8"
        maskStrokeWidth={1}
      />
    </ReactFlow>
  );
}

export function SchemeFlowCanvas({
  session,
  onSelect
}: {
  session: SchemeSessionSnapshot;
  onSelect: (selection: SchemeCanvasSelection) => void;
}) {
  return (
    <div className="relative h-full min-h-[420px] w-full">
      <div className="absolute inset-0">
        <ReactFlowProvider>
          <SchemeFlowInner key={session.id} session={session} onSelect={onSelect} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
