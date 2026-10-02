import { NextResponse } from 'next/server';
import { isAgentServiceRequest } from '@/lib/auth/service-token';
import { getChatConversation } from '@/lib/chat-history';
import {
  conversationIdFromWorkspace,
  detectsNegatedLearningRequest,
  latestUserMessageForLearning,
  listUserLearningMemories,
  normalizeAgentLearningMemory,
  saveUserLearningMemories,
  searchUserLearningMemories
} from '@/lib/self-learning';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!isAgentServiceRequest(request)) {
    return jsonError('无权调用自学习保存接口。', 401);
  }
  try {
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      query?: string;
      workspace?: string;
      instruction?: string;
      kind?: string;
      operation?: string;
      applicability?: string;
      keywords?: unknown;
      domainKey?: string;
      domainLabel?: string;
    };
    const conversationId = conversationIdFromWorkspace(String(body.workspace || ''));
    if (!conversationId) {
      return jsonError('只能在智能对话会话目录中保存私有记忆。');
    }
    const conversation = await getChatConversation(conversationId);
    const userId = conversation?.user_id?.trim() || '';
    if (!userId) return jsonError('无法确定当前会话所属用户，未写入记忆。', 403);

    const action = String(body.action || 'save').trim() || 'save';
    // 【按线上版本补回】search：按关键词检索当前用户的私有记忆。
    if (action === 'search') {
      const query = String(body.query || '').trim();
      const memories = query ? await searchUserLearningMemories(userId, query) : [];
      return NextResponse.json({
        conversationId,
        count: memories.length,
        memories: memories.map((memory) => ({
          id: memory.id,
          domainKey: memory.domainKey,
          domainLabel: memory.domainLabel,
          kind: memory.kind,
          instruction: memory.instruction,
          applicability: memory.applicability,
          pinned: memory.pinned,
          active: memory.active
        }))
      });
    }
    if (action === 'list') {
      const memories = await listUserLearningMemories(userId);
      return NextResponse.json({
        conversationId,
        count: memories.length,
        memories: memories.map((memory) => ({
          id: memory.id,
          domainKey: memory.domainKey,
          domainLabel: memory.domainLabel,
          kind: memory.kind,
          instruction: memory.instruction,
          applicability: memory.applicability,
          active: memory.active
        }))
      });
    }
    if (action !== 'save') return jsonError('action 只能是 save、list 或 search。');

    const latestUser = await latestUserMessageForLearning(conversationId);
    if (latestUser?.content && detectsNegatedLearningRequest(latestUser.content)) {
      return jsonError('用户明确要求不要记住本次内容，未写入。');
    }

    const learning = normalizeAgentLearningMemory(body);
    const memories = await saveUserLearningMemories({
      userId,
      conversationId,
      userMessageId: latestUser?.id || null,
      learning
    });
    const saved = memories[0];
    if (!saved) return jsonError('记忆未能写入。', 500);
    return NextResponse.json({
      ok: true,
      conversationId,
      memory: {
        id: saved.id,
        domainKey: saved.domainKey,
        domainLabel: saved.domainLabel,
        kind: saved.kind,
        instruction: saved.instruction,
        applicability: saved.applicability
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '保存自学习记忆失败。', 400);
  }
}
