import { NextResponse } from 'next/server';
import { runOpenCodeResearchReview } from '@/lib/opencode/research-review';
import type { RuntimeAgentStep } from '@/lib/opencode/types';
import { mergeRuntimeAgentStep, sortRuntimeAgentSteps } from '@/lib/opencode/agent-step-order';
import {
  appendChatMessage,
  assertConversationOwner,
  DEFAULT_CONVERSATION_TITLE,
  ensureChatConversation,
  getChatConversation,
  getChatMessages,
  scheduleUntitledConversationTitle,
  lockConversationReasoningRatio,
  normalizeConversationReasoningRatio,
  truncateChatMessagesFrom,
  truncateChatMessagesKeepFirst
} from '@/lib/chat-history';
import { beginConversationRun, finishConversationRun } from '@/lib/chat-run-registry';
import {
  createAssistantTurnPersister,
  resolveAssistantMessageId,
  resolveChatMessageId
} from '@/lib/chat-turn-persist';
import {
  bindChatAttachmentsToMessage,
  getChatAttachment,
  getChatAttachmentRow
} from '@/lib/chat-attachments';
import {
  RESEARCH_REVIEW_ATTACHMENT_MAX_BIND_FILES,
  RESEARCH_REVIEW_KIND
} from '@/lib/research-review/constants';
import { createResearchReviewArtifact } from '@/lib/research-review/artifacts';
import { requireUser } from '@/lib/auth/request';
import { requestWallClockMs } from '@/lib/chat-thinking-duration';
import { parseChatThunder, resolveReasoningTier } from '@/lib/reasoning-tier';
import { chatModelFromEndpointRole } from '@/lib/model-ids';
import { CHAT_NDJSON_HEADERS, CHAT_STREAM_HEARTBEAT_MS } from '@/lib/chat-ndjson-stream';
import { createChatStreamPublisher, notifyChatConversationChanged, publishChatLive } from '@/lib/chat-live';
import { commitQueuedUserSendTurn, getUserSendTurn } from '@/lib/chat-send-queue-store';

export const maxDuration = 18000;
export const dynamic = 'force-dynamic';

type ChatMessage = { role?: string; content?: string; sources?: Array<{ id?: string }> };

function jsonError(message: string, status = 500, detail?: unknown) {
  return NextResponse.json({ error: message, detail: detail instanceof Error ? detail.message : detail }, { status });
}

function encodeEvent(event: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function buildConversationContext(messages: ChatMessage[]) {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${String(message.content || '').trim()}`)
    .filter((line) => !/^[用户助手]+：$/.test(line))
    .join('\n')
    .slice(-12_000);
}

export async function POST(request: Request) {
  let setupRunHandle: Awaited<ReturnType<typeof beginConversationRun>> = null;
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const userId = auth.user!.id;

    const body = await request.json().catch(() => null);
    let attachmentIds: string[] = Array.isArray(body?.attachmentIds)
      ? [...new Set<string>(
          body.attachmentIds
            .map((value: unknown) => String(value || '').trim())
            .filter((value: string) => Boolean(value))
        )]
      : [];
    const requestedConversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    let requestedConversationExisted = false;
    const queueItemId = typeof body?.queueItemId === 'string' ? body.queueItemId.trim() : '';
    let queuedTurn: Awaited<ReturnType<typeof getUserSendTurn>> = null;
    const truncateFromMessageId = typeof body?.truncateFromMessageId === 'string'
      ? body.truncateFromMessageId.trim()
      : '';
    const truncateKeepCount = Number.isFinite(Number(body?.truncateKeepCount))
      ? Math.max(0, Math.floor(Number(body.truncateKeepCount)))
      : null;
    let messages = Array.isArray(body?.messages) ? body.messages as ChatMessage[] : [];

    if ((attachmentIds.length || queueItemId) && !requestedConversationId) {
      return jsonError('附件必须绑定到已创建的会话。', 400);
    }
    if (requestedConversationId) {
      const ownership = await assertConversationOwner(
        requestedConversationId,
        userId,
        RESEARCH_REVIEW_KIND
      );
      requestedConversationExisted = ownership.exists;
      if (ownership.exists && !ownership.allowed) {
        return ownership.conversation
          ? jsonError('无权访问该会话。', 403)
          : jsonError('会话不存在。', 404);
      }
      if (!ownership.exists && attachmentIds.length) {
        return jsonError('会话不存在。', 404);
      }
      if (queueItemId) {
        if (!ownership.exists) return jsonError('会话不存在。', 404);
        queuedTurn = await getUserSendTurn(userId, requestedConversationId, queueItemId);
        if (!queuedTurn) return jsonError('排队项已被其它窗口处理，请刷新后重试。', 409);
        attachmentIds = queuedTurn.attachments.map((attachment) => attachment.id);
      }
    }
    if (attachmentIds.length > RESEARCH_REVIEW_ATTACHMENT_MAX_BIND_FILES) {
      return jsonError(`每条消息最多附加 ${RESEARCH_REVIEW_ATTACHMENT_MAX_BIND_FILES} 个文件。`, 413);
    }
    const question = String(queuedTurn?.question ?? body?.question ?? '').trim()
      || (attachmentIds.length ? '请基于这些文献撰写研究综述' : '');
    const currentAttachments = attachmentIds.length
      ? await Promise.all(attachmentIds.map((attachmentId) => getChatAttachment(requestedConversationId, attachmentId)))
      : [];
    const currentAttachmentRows = attachmentIds.length
      ? await Promise.all(attachmentIds.map((attachmentId) => getChatAttachmentRow(requestedConversationId, attachmentId)))
      : [];
    if (currentAttachments.some((attachment) => !attachment || attachment.status !== 'ready')) {
      return jsonError('部分附件不存在、尚未解析完成或不属于当前会话。', 403);
    }
    if (currentAttachmentRows.some((attachment) => !attachment || attachment.parse_status !== 'ready')) {
      return jsonError('部分附件文本不可用于综述生成。', 403);
    }

    if (!question) return jsonError('请输入问题。', 400);
    const conversationId = requestedConversationId || crypto.randomUUID();
    const userMessageId = resolveChatMessageId(queuedTurn?.userMessageId || body?.userMessageId);
    const assistantMessageId = await resolveAssistantMessageId(
      queuedTurn?.assistantMessageId || body?.assistantMessageId,
      conversationId
    );
    setupRunHandle = await beginConversationRun(conversationId, userId);
    if (!setupRunHandle) return jsonError('该会话正在生成，请等待当前回答结束或加入排队。', 409);
    const runHandle = setupRunHandle;
    const runController = runHandle.controller;

    if (requestedConversationId) {
      const lockedOwnership = await assertConversationOwner(
        requestedConversationId,
        userId,
        RESEARCH_REVIEW_KIND
      );
      if (lockedOwnership.exists && !lockedOwnership.allowed) {
        return lockedOwnership.conversation
          ? jsonError('无权访问该会话。', 403)
          : jsonError('会话不存在。', 404);
      }
      if (requestedConversationExisted && !lockedOwnership.exists) {
        return jsonError('会话状态刚刚发生变化，请刷新后重试。', 409);
      }
    }

    if (requestedConversationId && (truncateFromMessageId || truncateKeepCount != null)) {
      let truncated = false;
      if (truncateFromMessageId) {
        truncated = await truncateChatMessagesFrom(requestedConversationId, truncateFromMessageId);
      }
      if (!truncated && truncateKeepCount != null) {
        truncated = await truncateChatMessagesKeepFirst(requestedConversationId, truncateKeepCount);
      }
      if (!truncated) return jsonError('无法定位要重新发送的消息。', 404);
    }

    let storedMessageCount = 0;
    let storedConversation: Awaited<ReturnType<typeof getChatConversation>> = undefined;
    if (requestedConversationId) {
      const stored = await getChatMessages(requestedConversationId);
      storedMessageCount = stored.length;
      storedConversation = await getChatConversation(requestedConversationId);
      if (stored.length) {
        messages = stored.map((message) => ({
          role: message.role,
          content: message.content,
          sources: message.sources
        }));
      } else {
        messages = [];
      }
    }

    let reasoningRatio = normalizeConversationReasoningRatio(body?.reasoningRatio);
    let modelRole = body?.modelRole === 'large' ? 'large' as const : 'small' as const;
    let reasoningEffort = body?.reasoningEffort === 'high' ? 'high' as const : 'default' as const;
    if (storedMessageCount > 0) {
      if (storedConversation?.reasoning_ratio != null) {
        reasoningRatio = normalizeConversationReasoningRatio(storedConversation.reasoning_ratio);
      }
      const lockedTier = resolveReasoningTier(reasoningRatio);
      // 科研传承不提供 storm 档：只区分本地小模型与远程大模型
      modelRole = lockedTier.modelRole === 'large' ? 'large' : 'small';
      reasoningEffort = lockedTier.reasoningEffort;
    }
    const conversationContext = buildConversationContext(messages);

    if (queueItemId) {
      if (runController.signal.aborted) {
        return jsonError('当前生成租约已失效，请重试。', 409);
      }
      await commitQueuedUserSendTurn({
        userId,
        conversationId,
        queueItemId,
        runId: runHandle.runId,
        kind: RESEARCH_REVIEW_KIND,
        maxAttachmentFiles: RESEARCH_REVIEW_ATTACHMENT_MAX_BIND_FILES,
        messageContent: question
      });
      await publishChatLive(userId, {
        type: 'list',
        conversationId,
        event: { resource: 'send-queue' }
      });
    }

    const title = DEFAULT_CONVERSATION_TITLE;
    let streamClosed = false;

    const stream = new ReadableStream({
      async start(controller) {
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const livePublisher = createChatStreamPublisher({
          userId,
          conversationId,
          kind: RESEARCH_REVIEW_KIND,
          userMessageId,
          assistantMessageId,
          userContent: question
        });
        const runStream = async () => {
        let answer = '';
        let sources: Awaited<ReturnType<typeof runOpenCodeResearchReview>>['sources'] = [];
        let graphSeedIds: Awaited<ReturnType<typeof runOpenCodeResearchReview>>['graphSeedIds'] = [];
        let agentSteps: RuntimeAgentStep[] = [];
        const runStartedAt = Date.now();
        const persister = createAssistantTurnPersister();
        await notifyChatConversationChanged({
          userId,
          conversationId,
          kind: RESEARCH_REVIEW_KIND,
          generating: true,
          userMessageId,
          assistantMessageId,
          userContent: question
        });
        const snapshot = () => ({
          id: assistantMessageId,
          conversationId,
          content: answer,
          sources,
          graphSeedIds,
          agentSteps,
          chatModel: chatModelFromEndpointRole(modelRole),
          // 科研传承走旧四档滑块，没有独立思考档：高能量档开 xhigh，其余关思考。
          thinkingId: reasoningEffort === 'high' ? 'xhigh' : 'off'
        });
        const safeEnqueue = (event: unknown, options?: { ignoreAbort?: boolean }) => {
          if (!streamClosed && (!request.signal.aborted || options?.ignoreAbort)) {
            try {
              controller.enqueue(encodeEvent(event));
            } catch {
              streamClosed = true;
            }
          }
          livePublisher.publish(event);
        };
        heartbeat = setInterval(() => {
          safeEnqueue({ type: 'status', phase: 'heartbeat', detail: '连接保持中…' }, { ignoreAbort: true });
        }, CHAT_STREAM_HEARTBEAT_MS);
        try {
          safeEnqueue({
            type: 'meta',
            conversationId,
            title,
            sources,
            graphSeedIds
          });
          safeEnqueue({ type: 'status', phase: 'start', detail: '正在写入会话并绑定文献…' });
          if (conversationContext) {
            safeEnqueue({
              type: 'status',
              phase: 'memory',
              detail: `已将最近对话上下文交给科研传承助手 · ${conversationContext.length} 字`
            });
          }

          const currentConversation = await ensureChatConversation(
            conversationId,
            title,
            userId,
            reasoningRatio,
            RESEARCH_REVIEW_KIND,
            typeof body?.thunder === 'undefined' ? undefined : parseChatThunder(body.thunder)
          );
          if (currentConversation?.reasoning_ratio == null) {
            await lockConversationReasoningRatio(conversationId, reasoningRatio);
          }
          if (!queueItemId) {
            await appendChatMessage({
              id: userMessageId,
              conversationId,
              role: 'user',
              content: question
            });
            if (attachmentIds.length) {
              safeEnqueue({
                type: 'status',
                phase: 'bind_attachments',
                detail: `正在绑定 ${attachmentIds.length} 个附件到本轮消息…`
              });
              await bindChatAttachmentsToMessage(conversationId, userMessageId, attachmentIds, {
                maxFiles: RESEARCH_REVIEW_ATTACHMENT_MAX_BIND_FILES
              });
            }
          }
          await persister.flush(snapshot(), true);
          scheduleUntitledConversationTitle({
            conversationId,
            question,
            currentTitle: currentConversation?.title,
            scope: { userId, kind: RESEARCH_REVIEW_KIND },
            onNamed: (nextTitle) => safeEnqueue({ type: 'title', conversationId, title: nextTitle })
          });

          const result = await runOpenCodeResearchReview(question, {
            conversationContext,
            conversationId,
            currentAttachments: currentAttachments.filter((attachment) => attachment !== null),
            currentAttachmentRows: currentAttachmentRows.filter((attachment) => attachment !== null),
            reasoningEffort,
            modelRole,
            signal: runController.signal,
            onStatus: (status) => {
              safeEnqueue({ type: 'status', phase: status.phase, detail: status.detail });
            },
            onAgentStep: async (step) => {
              agentSteps = mergeRuntimeAgentStep(agentSteps, step);
              safeEnqueue({ type: 'agent_step', step });
              persister.schedule(snapshot());
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
            },
            onTextDelta: async (content) => {
              answer += content;
              safeEnqueue({ type: 'chunk', content });
              persister.schedule(snapshot());
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
            },
            onAnswerReset: async () => {
              answer = '';
              safeEnqueue({ type: 'answer_reset' });
              persister.schedule(snapshot());
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
            },
            onAnswerReplace: async (content) => {
              answer = content;
              safeEnqueue({ type: 'answer_replace', content });
              persister.schedule(snapshot());
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
            },
            onContextUsage: (usage) => safeEnqueue({ type: 'context_usage', usage })
          });
          if (result.answer !== answer) {
            throw new Error('科研传承助手最终答案与流协议不同步，已拒绝落库。');
          }
          sources = result.sources;
          graphSeedIds = result.graphSeedIds;
          agentSteps = sortRuntimeAgentSteps(result.agentSteps);

          const finalTitle = currentConversation?.title || title;
          safeEnqueue({
            type: 'status',
            phase: 'export_docx',
            detail: '正在生成 Word 附件…'
          });
          const paperCount = currentAttachmentRows.filter((row) => row?.parse_status === 'ready').length;
          const created = await createResearchReviewArtifact({
            conversationId,
            messageId: assistantMessageId,
            markdown: answer,
            conversationTitle: finalTitle,
            paperCount
          });
          const completionNote = created.completionNote;
          const thinkingDurationMs = requestWallClockMs(runStartedAt, result.metrics.totalDurationMs);
          const metrics = { ...result.metrics, totalDurationMs: thinkingDurationMs };

          safeEnqueue({
            type: 'meta',
            conversationId,
            title: finalTitle,
            sources: [],
            graphSeedIds: [],
            agentSteps,
            confidence: result.confidence,
            intent: result.intent,
            trace: metrics
          });
          safeEnqueue({
            type: 'answer_replace',
            content: completionNote
          });
          safeEnqueue({
            type: 'artifact',
            artifact: created.artifact
          });
          await persister.flush({
            ...snapshot(),
            content: completionNote,
            sources: [],
            graphSeedIds: [],
            thinkingDurationMs,
            contextUsage: metrics
          }, false);
          safeEnqueue({
            type: 'done',
            conversationId,
            traceId: metrics.traceId,
            metrics,
            artifact: created.artifact
          });
        } catch (error) {
          const stopped = runController.signal.aborted;
          if (stopped) {
            const partial = answer.trim();
            try {
              await persister.flush({
                ...snapshot(),
                content: partial
                  ? `${partial}\n\n（生成中断，以上为已收到的部分内容。）`
                  : '生成已中断。',
                thinkingDurationMs: requestWallClockMs(runStartedAt)
              }, false);
            } catch (persistError) {
              const detail = persistError instanceof Error ? persistError.message : String(persistError);
              safeEnqueue({ type: 'error', error: `生成已中断，但保存失败：${detail}` }, { ignoreAbort: true });
              return;
            }
            safeEnqueue({ type: 'done', conversationId }, { ignoreAbort: true });
            return;
          }
          let message = error instanceof Error ? error.message : '查询失败';
          const failedContent = answer.trim()
            ? `${answer.trim()}\n\n抱歉，查询失败：${message}`
            : `抱歉，查询失败：${message}`;
          try {
            await persister.flush({
              ...snapshot(),
              content: failedContent,
              thinkingDurationMs: requestWallClockMs(runStartedAt)
            }, false);
          } catch (persistError) {
            const detail = persistError instanceof Error ? persistError.message : String(persistError);
            message = `${message}；对话保存失败：${detail}`;
          }
          safeEnqueue({ type: 'error', error: message }, { ignoreAbort: true });
        }
        };
        try {
          await runStream();
        } finally {
          try {
            await livePublisher.flush();
            const finishedCurrentRun = await finishConversationRun(runHandle);
            if (finishedCurrentRun) {
              await notifyChatConversationChanged({
                userId,
                conversationId,
                kind: RESEARCH_REVIEW_KIND,
                generating: false,
                userMessageId,
                assistantMessageId
              });
            }
          } catch (cleanupError) {
            console.error('[research-review] failed to finalize run state', cleanupError);
          } finally {
            if (heartbeat) clearInterval(heartbeat);
            streamClosed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        }
      },
      cancel() {
        streamClosed = true;
        console.warn('[research-review] client stream closed; agent run continues', conversationId);
      }
    });
    setupRunHandle = null;

    return new Response(stream, {
      headers: CHAT_NDJSON_HEADERS
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '查询失败';
    const status = message.includes('API Key') ? 400 : 500;
    return jsonError(message, status);
  } finally {
    if (setupRunHandle) {
      try {
        await finishConversationRun(setupRunHandle);
      } catch (cleanupError) {
        console.error('[research-review] failed to release setup run lease', cleanupError);
      }
    }
  }
}
