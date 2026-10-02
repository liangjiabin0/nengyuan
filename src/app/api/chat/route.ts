import { NextResponse } from 'next/server';
import { runOpenCodeChat } from '@/lib/opencode/chat';
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
  saveConversationSkillIds,
  truncateChatMessagesFrom,
  truncateChatMessagesKeepFirst
} from '@/lib/chat-history';
import {
  bindChatAttachmentsToMessage,
  getChatAttachment,
  getChatAttachmentRow,
  CHAT_ATTACHMENT_MAX_BIND_FILES
} from '@/lib/chat-attachments';
import { requireUser } from '@/lib/auth/request';
import { CHART_DISCOVERY_SKILL } from '@/lib/bundled-skills';
import { harvestAgentDeliverables } from '@/lib/chat-deliverables';
import { harvestGeneratedChartAttachments } from '@/lib/chat-generated-charts';
import {
  resolveLockedChatRunSettings
} from '@/lib/reasoning-tier';
import { fallbackThinkingLevels } from '@/lib/thinking-levels-core';
import { detectThinkingLevels } from '@/lib/thinking-levels';
import { requestWallClockMs } from '@/lib/chat-thinking-duration';
import { beginConversationRun, finishConversationRun } from '@/lib/chat-run-registry';
import {
  createAssistantTurnPersister,
  resolveAssistantMessageId,
  resolveChatMessageId
} from '@/lib/chat-turn-persist';
import {
  loadPinnedLearningContext
} from '@/lib/self-learning';
import { CHAT_NDJSON_HEADERS, CHAT_STREAM_HEARTBEAT_MS } from '@/lib/chat-ndjson-stream';
import { createChatStreamPublisher, notifyChatConversationChanged, publishChatLive } from '@/lib/chat-live';
import { commitQueuedUserSendTurn, getUserSendTurn } from '@/lib/chat-send-queue-store';

/** Allow long OpenCode tool loops (LAN 27B) without platform killing the stream. */
export const maxDuration = 18000;
export const dynamic = 'force-dynamic';

type ChatMessage = { role?: string; content?: string; sources?: Array<{ id?: string }> };

function jsonError(message: string, status = 500, detail?: unknown) {
  return NextResponse.json({ error: message, detail: detail instanceof Error ? detail.message : detail }, { status });
}

function encodeEvent(event: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

async function collectAgentFiles(
  conversationId: string,
  messageId: string,
  options: { answer?: string; startedAtMs?: number; collectCharts?: boolean } = {}
) {
  /**
   * A write/edit tool can finish its protocol event just before the actual
   * file becomes visible on disk (especially on the Windows sidecar). Keep
   * scanning for a short settling window and merge every pass so late files
   * are included in the same assistant turn.
  */
  const retryDelays = [0, 150, 350, 750, 1_500, 3_000];
  const startedSettlingAt = Date.now();
  const minimumSettlingMs = 1_500;
  const byId = new Map<string, Awaited<ReturnType<typeof harvestAgentDeliverables>>[number]>();
  let stablePasses = 0;
  let previousCount = 0;
  for (const delay of retryDelays) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      const charts = options.collectCharts === false
        ? []
        : await harvestGeneratedChartAttachments(conversationId, messageId, options);
      const files = await harvestAgentDeliverables(conversationId, messageId, {
        ...options,
        // When chart generation is enabled, the chart collector owns charts/;
        // otherwise keep scanning it for legacy sessions.
        includeCharts: options.collectCharts !== true
      });
      for (const attachment of [...charts, ...files]) byId.set(attachment.id, attachment);
      if (byId.size === previousCount) stablePasses += 1;
      else stablePasses = 0;
      previousCount = byId.size;
      // Two unchanged passes are enough to settle an already visible output;
      // an empty result keeps trying through the full window.
      if (byId.size > 0 && stablePasses >= 2 && Date.now() - startedSettlingAt >= minimumSettlingMs) break;
    } catch (error) {
      console.error('[chat] harvest agent deliverables failed', error);
    }
  }
  return [...byId.values()];
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

function interruptedContent(answer: string) {
  const partial = answer.trim();
  return partial
    ? `${partial}\n\n（生成中断，以上为已收到的部分内容。）`
    : '生成已中断。';
}

function parseChartGenerationRequest(body: unknown): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  if (rec.enableChartGeneration === true || rec.composerTool === 'chart-generation') return true;
  if (rec.enableChartGeneration === false) return false;
  return undefined;
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
      const ownership = await assertConversationOwner(requestedConversationId, userId, 'chat');
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
    if (attachmentIds.length > CHAT_ATTACHMENT_MAX_BIND_FILES) {
      return jsonError(`每条消息最多附加 ${CHAT_ATTACHMENT_MAX_BIND_FILES} 个文件。`, 413);
    }
    const question = String(queuedTurn?.question ?? body?.question ?? '').trim()
      || (attachmentIds.length ? '请阅读并概括这些附件' : '');
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
      return jsonError('部分附件文本不可用于能元分析。', 403);
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
      const lockedOwnership = await assertConversationOwner(requestedConversationId, userId, 'chat');
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
      // 前端会话内临时 ID 可能与库内 ID 不一致：按保留条数兜底截断。
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

    const lockedInput = {
      hasMessages: storedMessageCount > 0,
      storedRatio: storedConversation?.reasoning_ratio,
      storedThunder: storedConversation?.thunder,
      storedChatModel: storedConversation?.chat_model,
      requestedRatio: body?.reasoningRatio,
      requestedThunder: body?.thunder,
      requestedModelRole: body?.modelRole,
      requestedChatModel: body?.chatModel ?? body?.chat_model,
      requestedSmallThinking: body?.smallThinking,
      requestedThinkingId: body?.thinkingId
    };
    const preview = resolveLockedChatRunSettings(lockedInput);
    const thinkingCatalog = await detectThinkingLevels(preview.chatModel).catch(() => null);
    const { reasoningRatio, smallThinking, thinkingId, modelRole, chatModel } = resolveLockedChatRunSettings({
      ...lockedInput,
      levels: thinkingCatalog?.levels?.length
        ? thinkingCatalog.levels
        : fallbackThinkingLevels(preview.chatModel)
    });
    const conversationContext = buildConversationContext(messages);
    const pinnedLearning = await loadPinnedLearningContext(userId).catch((error) => {
      console.warn('[self-learning] pinned load failed', error);
      return { memories: [], prompt: '', fingerprint: '' };
    });

    if (queueItemId) {
      if (runController.signal.aborted) {
        return jsonError('当前生成租约已失效，请重试。', 409);
      }
      await commitQueuedUserSendTurn({
        userId,
        conversationId,
        queueItemId,
        runId: runHandle.runId,
        kind: 'chat',
        maxAttachmentFiles: CHAT_ATTACHMENT_MAX_BIND_FILES,
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
          kind: 'chat',
          userMessageId,
          assistantMessageId,
          userContent: question
        });
        const runStream = async () => {
        let answer = '';
        let sources: Awaited<ReturnType<typeof runOpenCodeChat>>['sources'] = [];
        let graphSeedIds: Awaited<ReturnType<typeof runOpenCodeChat>>['graphSeedIds'] = [];
        let agentSteps: RuntimeAgentStep[] = [];
        const runStartedAt = Date.now();
        const persister = createAssistantTurnPersister();
        let enableChartGeneration = false;
        await notifyChatConversationChanged({
          userId,
          conversationId,
          kind: 'chat',
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
          chatModel,
          thinkingId
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
            graphSeedIds,
            chatModel,
            reasoningRatio,
            thinkingId
          });
          safeEnqueue({ type: 'status', phase: 'start', detail: '正在理解问题…' });
          if (conversationContext) {
            safeEnqueue({
              type: 'status',
              phase: 'memory',
              detail: `已将最近对话上下文交给能元 · ${conversationContext.length} 字`
            });
          }

          const currentConversation = await ensureChatConversation(
            conversationId,
            title,
            userId,
            reasoningRatio,
            'chat',
            chatModel === 'thunder',
            chatModel
          );
          enableChartGeneration = parseChartGenerationRequest(body)
            ?? (currentConversation?.skillIds || []).includes(CHART_DISCOVERY_SKILL);
          await saveConversationSkillIds(
            conversationId,
            enableChartGeneration ? [CHART_DISCOVERY_SKILL] : []
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
              await bindChatAttachmentsToMessage(conversationId, userMessageId, attachmentIds);
            }
          }
          await persister.flush(snapshot(), true);
          scheduleUntitledConversationTitle({
            conversationId,
            question,
            currentTitle: currentConversation?.title,
            scope: { userId, kind: 'chat' },
            onNamed: (nextTitle) => safeEnqueue({ type: 'title', conversationId, title: nextTitle })
          });

          const result = await runOpenCodeChat(question, {
            conversationContext,
            conversationId,
            currentAttachments: currentAttachments.filter((attachment) => attachment !== null),
            currentAttachmentRows: currentAttachmentRows.filter((attachment) => attachment !== null),
            smallThinking,
            thinkingId,
            modelRole,
            chatModel,
            reasoningEffort: chatModel === 'arc' ? 'default' : (thinkingId === 'off' ? 'default' : 'high'),
            enableChartGeneration,
            learningMemoryPrompt: pinnedLearning.prompt,
            learningMemoryFingerprint: pinnedLearning.fingerprint,
            learningMemoryCount: pinnedLearning.memories.length,
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
            throw new Error('能元最终答案与流协议不同步，已拒绝落库。');
          }
          sources = result.sources;
          graphSeedIds = result.graphSeedIds;
          agentSteps = sortRuntimeAgentSteps(result.agentSteps);

          const finalTitle = currentConversation?.title || title;
          const thinkingDurationMs = requestWallClockMs(runStartedAt, result.metrics.totalDurationMs);
          const metrics = { ...result.metrics, totalDurationMs: thinkingDurationMs };

          safeEnqueue({
            type: 'meta',
            conversationId,
            title: finalTitle,
            sources,
            graphSeedIds,
            agentSteps,
            confidence: result.confidence,
            intent: result.intent,
            trace: metrics
          });
          await persister.flush({
            ...snapshot(),
            thinkingDurationMs,
            contextUsage: metrics
          }, false);
          safeEnqueue({ type: 'status', phase: 'attachments', detail: '正在整理本轮 AI 交付附件…' });
          const generatedAttachments = await collectAgentFiles(conversationId, assistantMessageId, {
            answer: result.answer,
            startedAtMs: runStartedAt,
            collectCharts: enableChartGeneration
          });
          safeEnqueue({
            type: 'done',
            conversationId,
            traceId: metrics.traceId,
            metrics,
            attachments: generatedAttachments
          }, { ignoreAbort: true });
        } catch (error) {
          const stopped = runController.signal.aborted;
          if (stopped) {
            try {
              await persister.flush({
                ...snapshot(),
                content: interruptedContent(answer),
                thinkingDurationMs: requestWallClockMs(runStartedAt)
              }, false);
            } catch (persistError) {
              const detail = persistError instanceof Error ? persistError.message : String(persistError);
              safeEnqueue({ type: 'error', error: `生成已中断，但保存失败：${detail}` }, { ignoreAbort: true });
              return;
            }
            const generatedAttachments = await collectAgentFiles(conversationId, assistantMessageId, {
              answer,
              startedAtMs: runStartedAt,
              collectCharts: enableChartGeneration
            });
            safeEnqueue({
              type: 'done',
              conversationId,
              attachments: generatedAttachments
            }, { ignoreAbort: true });
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
          // A tool run can fail after producing a valid report or dataset. Keep
          // those deliberate deliverables available even when the text turn
          // itself ends in an error.
          const generatedAttachments = await collectAgentFiles(conversationId, assistantMessageId, {
            answer,
            startedAtMs: runStartedAt,
            collectCharts: enableChartGeneration
          });
          safeEnqueue({
            type: 'done',
            conversationId,
            attachments: generatedAttachments
          }, { ignoreAbort: true });
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
                kind: 'chat',
                generating: false,
                userMessageId,
                assistantMessageId
              });
            }
          } catch (cleanupError) {
            console.error('[chat] failed to finalize run state', cleanupError);
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
        console.warn('[chat] client stream closed; agent run continues', conversationId);
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
        console.error('[chat] failed to release setup run lease', cleanupError);
      }
    }
  }
}
