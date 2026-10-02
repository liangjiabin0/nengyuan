'use client';

import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  collectVisibleChatAgentNodes,
  isTaskToolName,
  parentOnlySteps,
  resolveTaskNode,
  stepsForNode,
  type ChatAgentNode
} from '@/lib/opencode/chat-subagents';
import type { ChatReproProgress } from '@/lib/opencode/chat-repro-types';
import type { RuntimeAgentStep } from '@/lib/opencode/types';
import { formatThinkingClock } from '@/lib/chat-thinking-duration';
import { StickToBottomFrame } from '@/components/stick-to-bottom';

type AgentStep = RuntimeAgentStep;

function statusLabel(status: ChatAgentNode['status']) {
  if (status === 'done') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已停止';
  if (status === 'pending') return '待派发';
  return '进行中';
}

function formatDuration(ms?: number) {
  if (!ms || ms < 0) return '';
  return formatThinkingClock(ms, 1);
}

export function parentTranscriptSteps(steps: AgentStep[], parentSessionId?: string) {
  return parentOnlySteps(steps, parentSessionId);
}

export function taskStepKey(step: Pick<AgentStep, 'parentToolCallId' | 'nodeId' | 'step'>) {
  return step.parentToolCallId || step.nodeId || `task-${step.step}`;
}

const TASK_DOT_COLORS = [
  '#38bdf8',
  '#818cf8',
  '#a78bfa',
  '#e879f9',
  '#f472b6',
  '#fb7185',
  '#fb923c',
  '#fbbf24',
  '#a3e635',
  '#4ade80',
  '#2dd4bf',
  '#22d3ee'
] as const;

function taskDotColor(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return TASK_DOT_COLORS[hash % TASK_DOT_COLORS.length];
}

export function TaskSubagentButton({
  step,
  node,
  active,
  onOpen
}: {
  step: AgentStep;
  node?: ChatAgentNode | null;
  active?: boolean;
  onOpen: (key: string) => void;
}) {
  const title = node?.title
    || String(step.input?.description || step.input?.name || step.input?.title || step.content || '任务').replace(/\s+/g, ' ').trim();
  const status = node?.status || 'running';
  const running = status === 'running';
  const key = node ? (node.parentToolCallId || node.nodeId) : taskStepKey(step);
  return (
    <button
      type="button"
      className={`rag-oc-task rag-oc-task-${status}${active || running ? ' rag-oc-task-working' : ''}`}
      onClick={() => onOpen(key)}
      aria-label={`打开：${title}`}
    >
      <span
        className={`rag-oc-task-dot${running ? ' rag-oc-task-dot-running' : ''}`}
        style={{ '--rag-oc-dot': taskDotColor(`${key}:${title}`) } as CSSProperties}
        aria-hidden
      />
      <span className="rag-oc-task-title">{title}</span>
      <span className={`rag-oc-task-status${running ? ' rag-think-label-shimmer' : ''}`}>
        {statusLabel(status)}
        {formatDuration(node?.durationMs) ? ` · ${formatDuration(node?.durationMs)}` : ''}
      </span>
      <span className="rag-oc-task-chevron" aria-hidden>›</span>
    </button>
  );
}

export const SubagentSheetHostContext = createContext<HTMLElement | null>(null);

const SHEET_CLOSE_MS = 240;

export function SubagentSessionPanel({
  node,
  running,
  onClose,
  children,
  followKey
}: {
  node: ChatAgentNode;
  running?: boolean;
  onClose: () => void;
  children: ReactNode;
  followKey?: string | number;
}) {
  const host = useContext(SubagentSheetHostContext);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const nodeKey = node.parentToolCallId || node.nodeId;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const close = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(onClose, SHEET_CLOSE_MS);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sheet = (
    <div
      className={`rag-oc-task-overlay${entered && !leaving ? ' rag-oc-task-overlay-in' : ''}`}
      role="dialog"
      aria-label={node.title}
    >
      <button type="button" className="rag-oc-task-backdrop" aria-label="关闭" onClick={close} />
      <aside className="rag-oc-task-session">
        <div className="rag-oc-task-handle" aria-hidden />
        <header className="rag-oc-task-session-head">
          <div className="rag-oc-task-session-titles">
            <div className="rag-oc-task-session-title">{node.title}</div>
            <div className={`rag-oc-task-session-meta${running && node.status === 'running' ? ' rag-think-label-shimmer' : ''}`}>
              {statusLabel(node.status)}
              {node.sessionId ? ` · ${node.sessionId}` : ''}
              {formatDuration(node.durationMs) ? ` · ${formatDuration(node.durationMs)}` : ''}
            </div>
          </div>
          <button type="button" className="rag-oc-task-close" onClick={close} aria-label="关闭">
            ×
          </button>
        </header>
        <StickToBottomFrame
          className="rag-oc-task-session-body scrollbar-visible"
          wrapperClassName="min-h-0 flex-1"
          followKey={`${followKey ?? ''}:${entered ? 1 : 0}`}
          resetKey={nodeKey}
        >
          <div className="rag-oc-task-session-follow">
            {children || (
              <div className="rag-oc-prose-body">
                {running && node.status === 'running'
                  ? '正在运行…'
                  : node.status === 'stopped'
                    ? '父对话已结束，该子代理已停止。'
                    : '该节点还没有过程记录。'}
              </div>
            )}
          </div>
        </StickToBottomFrame>
      </aside>
    </div>
  );

  if (host) return createPortal(sheet, host);
  return sheet;
}

export function useVisibleTaskNodes(
  steps: AgentStep[],
  parentSessionId?: string,
  progressItems?: ChatReproProgress[] | null,
  parentActive?: boolean
) {
  return useMemo(
    () => collectVisibleChatAgentNodes(steps, parentSessionId, progressItems, { parentActive }),
    [steps, parentSessionId, progressItems, parentActive]
  );
}

export function taskNodeFromStep(
  step: AgentStep,
  allSteps: AgentStep[],
  parentSessionId?: string,
  progressItems?: ChatReproProgress[] | null,
  parentActive?: boolean
) {
  if (!isTaskToolName(step.tool) || step.type !== 'tool_call') return null;
  return resolveTaskNode(step, allSteps, parentSessionId, progressItems, { parentActive });
}

export function childTranscript(steps: AgentStep[], node: ChatAgentNode, parentSessionId?: string) {
  return stepsForNode(steps, node, parentSessionId);
}
