import { hasActiveSchemeResearchJob } from '@/lib/jobs/queue';
import { resolveDispatchCaseHint } from '@/lib/scheme-solve/dispatch-case';
import { inferEsoptCase } from '@/lib/scheme-solve/model-json';
import { inferModelicaSpec } from '@/lib/scheme-solve/modelica';
import { enqueueSchemeResearch, isSchemeResearchActive } from '@/lib/scheme-solve/orchestrator';
import {
  createSchemeSession,
  createSolvableIdea,
  getSchemeSnapshot,
  listSolvableIdeaIds,
  setSchemeSessionStatus,
  updateSchemeStage
} from '@/lib/scheme-solve/store';
import { inferTdmgCase } from '@/lib/scheme-solve/tdmg-case';
import type { SchemeSessionSnapshot } from '@/lib/scheme-solve/types';
import {
  getVirtualSimCapability,
  getVirtualSimTool,
  type VirtualSimCapabilityId,
  type VirtualSimToolId
} from './tools';

function inferCaseHint(toolId: VirtualSimToolId, prompt: string, fallback?: string) {
  if (toolId === 'acopf') return inferTdmgCase(prompt);
  if (toolId === 'dispatch') {
    return resolveDispatchCaseHint({ caseHint: fallback, title: prompt, summary: prompt, decisions: '' });
  }
  if (toolId === 'dcopf') return inferEsoptCase(prompt) || fallback || 'case24';
  if (toolId === 'modelica') return inferModelicaSpec(prompt).name;
  return fallback;
}

export function buildVirtualSimIdea(toolId: VirtualSimToolId, prompt: string, capabilityId?: VirtualSimCapabilityId) {
  const tool = getVirtualSimTool(toolId);
  const capability = capabilityId ? getVirtualSimCapability(capabilityId) : null;
  const compact = prompt.replace(/\s+/g, ' ').trim();
  const title = compact.length > 28 ? `${compact.slice(0, 28)}…` : compact;
  const routingText = capability ? `${capability.label} ${capability.method} ${compact}` : compact;
  const caseHint = toolId === 'forecast' && capability
    ? capability.id
    : inferCaseHint(toolId, routingText, tool.defaults.caseHint);
  const remapDispatch9 = toolId === 'dispatch'
    && /ieee\s*9|9\s*节点|9-bus/i.test(compact)
    && !/14|30|33|57|118/.test(compact);
  if (remapDispatch9) throw new Error('现有日前调度不支持 IEEE 9 模型，请选择支持的模型；IEEE 9 静态潮流可从方案设计节点的计算扩展进入。');
  return {
    title,
    summary: compact,
    problemClass: toolId,
    decisions: tool.defaults.decisions,
    limits: tool.defaults.limits,
    goal: tool.defaults.goal,
    caseHint,
    whySolvable: tool.defaults.whySolvable
  };
}

export async function createVirtualSimSession(
  prompt: string,
  userId: string,
  toolId: VirtualSimToolId,
  capabilityId?: VirtualSimCapabilityId,
  modelConfig?: Pick<import("@/lib/scheme-solve/types").SchemeSession, "chatModel" | "thinkingId">
) {
  const session = await createSchemeSession(prompt, userId, { source: 'virtual-sim', toolId, ...modelConfig });
  if (!session) throw new Error('创建仿真任务失败。');
  const idea = await createSolvableIdea(session.id, buildVirtualSimIdea(toolId, prompt, capabilityId));
  return { session, idea };
}

export async function startVirtualSimResearch(sessionId: string, ideaIds?: string[]) {
  const ids = ideaIds?.length ? ideaIds : await listSolvableIdeaIds(sessionId);
  if (!ids.length) throw new Error('没有可运行的仿真任务。');
  if (isSchemeResearchActive(sessionId) || await hasActiveSchemeResearchJob(sessionId)) {
    return await getSchemeSnapshot(sessionId);
  }
  await setSchemeSessionStatus(sessionId, 'researching', {
    progress: 5,
    detail: '已进入求解队列，AI 正在准备建模与求解',
    error: null
  });
  for (const ideaId of ids) {
    await updateSchemeStage(ideaId, 'design', {
      status: 'running',
      headline: '已进入求解队列，AI 正在准备建模'
    });
  }
  enqueueSchemeResearch(sessionId, ids).catch(async (error) => {
    const message = error instanceof Error ? error.message : '启动仿真失败。';
    await setSchemeSessionStatus(sessionId, 'failed', { detail: message, error: message });
  });
  return await getSchemeSnapshot(sessionId);
}

export async function snapshotOrThrow(sessionId: string): Promise<SchemeSessionSnapshot> {
  const snapshot = await getSchemeSnapshot(sessionId);
  if (!snapshot) throw new Error('仿真任务不存在。');
  return snapshot;
}
