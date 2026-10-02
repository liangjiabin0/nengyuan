import { NextResponse } from 'next/server';
import {
  assertConversationOwner,
  createChatConversation,
  DEFAULT_CONVERSATION_TITLE,
  deleteEmptyChatConversationOwnedBy
} from '@/lib/chat-history';
import {
  RESEARCH_REVIEW_ATTACHMENT_MAX_UPLOAD_FILES,
  RESEARCH_REVIEW_KIND
} from '@/lib/research-review/constants';
import {
  deleteResearchReviewAttachment,
  listResearchReviewAttachments,
  storeResearchReviewUpload
} from '@/lib/research-review/attachments';
import { requireUser } from '@/lib/auth/request';
import { notifyChatConversationChanged } from '@/lib/chat-live';
import { beginConversationMutation, finishConversationRun } from '@/lib/chat-run-registry';
import { stopConversationGenerationAndSettle } from '@/lib/chat-generation-stop';
import { deleteChatAttachmentIfUnqueued } from '@/lib/chat-attachments';

export const maxDuration = 900;
export const dynamic = 'force-dynamic';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const conversationId = new URL(request.url).searchParams.get('conversationId')?.trim() || '';
    if (!conversationId) return jsonError('缺少 conversationId。');
    const ownership = await assertConversationOwner(
      conversationId,
      auth.user!.id,
      RESEARCH_REVIEW_KIND
    );
    if (!ownership.conversation) return jsonError('会话不存在。', 404);
    if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
    const attachments = await listResearchReviewAttachments(conversationId);
    const currentOwnership = await assertConversationOwner(
      conversationId,
      auth.user!.id,
      RESEARCH_REVIEW_KIND
    );
    if (!currentOwnership.conversation || !currentOwnership.allowed) {
      return jsonError('会话状态已发生变化，请刷新后重试。', 409);
    }
    return NextResponse.json({ attachments });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '读取附件失败。', 500);
  }
}

export async function POST(request: Request) {
  const createdIds: Array<{ conversationId: string; attachmentId: string }> = [];
  let createdConversationId = '';
  let ownerId = '';
  let mutationLease: Awaited<ReturnType<typeof beginConversationMutation>> = null;
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    ownerId = auth.user!.id;
    const formData = await request.formData();
    const conversationId = String(formData.get('conversationId') || '').trim();
    const files = formData.getAll('files').filter((entry): entry is File => entry instanceof File);
    if (!files.length) return jsonError('请选择附件。');
    if (files.length > RESEARCH_REVIEW_ATTACHMENT_MAX_UPLOAD_FILES) {
      return jsonError(`一次最多上传 ${RESEARCH_REVIEW_ATTACHMENT_MAX_UPLOAD_FILES} 个文件。`, 413);
    }

    if (!conversationId) return jsonError('缺少 conversationId。');
    const ownership = await assertConversationOwner(
      conversationId,
      ownerId,
      RESEARCH_REVIEW_KIND
    );
    if (ownership.exists && !ownership.allowed) {
      return ownership.conversation
        ? jsonError('无权访问该会话。', 403)
        : jsonError('会话不存在。', 404);
    }

    mutationLease = await beginConversationMutation(conversationId, ownerId);
    if (!mutationLease) return jsonError('会话状态刚刚发生变化，请重试。', 409);

    const lockedOwnership = await assertConversationOwner(
      conversationId,
      ownerId,
      RESEARCH_REVIEW_KIND
    );
    if (lockedOwnership.exists && !lockedOwnership.allowed) {
      return lockedOwnership.conversation
        ? jsonError('无权访问该会话。', 403)
        : jsonError('会话不存在。', 404);
    }
    if (!lockedOwnership.exists) {
      await createChatConversation(
        conversationId,
        DEFAULT_CONVERSATION_TITLE,
        ownerId,
        undefined,
        RESEARCH_REVIEW_KIND
      );
      createdConversationId = conversationId;
    }

    const uploaded = [];
    const failed = [];
    for (const file of files) {
      const result = await storeResearchReviewUpload(conversationId, {
        name: file.name,
        type: file.type,
        buffer: Buffer.from(await file.arrayBuffer())
      });
      for (const attachment of result.attachments) {
        uploaded.push(attachment);
        if (!attachment.deduplicated) {
          createdIds.push({ conversationId, attachmentId: attachment.id });
        }
      }
      failed.push(...result.failed);
    }
    await notifyChatConversationChanged({
      userId: ownerId,
      conversationId,
      kind: RESEARCH_REVIEW_KIND,
      resource: 'attachments'
    });
    return NextResponse.json({ conversationId, attachments: uploaded, failed }, { status: 201 });
  } catch (error) {
    for (const created of createdIds) {
      await deleteResearchReviewAttachment(created.conversationId, created.attachmentId)
        .catch(() => false);
    }
    if (createdConversationId && ownerId) {
      await deleteEmptyChatConversationOwnedBy(
        createdConversationId,
        ownerId,
        RESEARCH_REVIEW_KIND
      ).catch(() => false);
    }
    const message = error instanceof Error ? error.message : '附件上传失败。';
    const status = /200 MB|最多/.test(message) ? 413 : /不存在|无效.*ID/.test(message) ? 404 : 422;
    return jsonError(message, status);
  } finally {
    if (mutationLease) {
      await finishConversationRun(mutationLease).catch((error) => {
        console.error('[research-review] failed to release attachment-upload lease', error);
      });
    }
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversationId')?.trim() || '';
    const attachmentId = searchParams.get('attachmentId')?.trim() || '';
    if (!conversationId || !attachmentId) return jsonError('缺少 conversationId 或 attachmentId。');
    const ownership = await assertConversationOwner(
      conversationId,
      auth.user!.id,
      RESEARCH_REVIEW_KIND
    );
    if (!ownership.conversation) return jsonError('会话不存在。', 404);
    if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
    if (!await stopConversationGenerationAndSettle(conversationId, auth.user!.id)) {
      return jsonError('当前生成仍在收尾，请稍后重试。', 409);
    }

    const mutationLease = await beginConversationMutation(conversationId, auth.user!.id);
    if (!mutationLease) return jsonError('会话状态刚刚发生变化，请重试。', 409);
    let conversationDeleted = false;
    try {
      const lockedOwnership = await assertConversationOwner(
        conversationId,
        auth.user!.id,
        RESEARCH_REVIEW_KIND
      );
      if (!lockedOwnership.conversation) return jsonError('会话不存在。', 404);
      if (!lockedOwnership.allowed) return jsonError('无权访问该会话。', 403);
      const deleteResult = await deleteChatAttachmentIfUnqueued(conversationId, attachmentId);
      if (deleteResult === 'queued') {
        return jsonError('附件已被排队消息引用，请先移除该排队消息。', 409);
      }
      if (deleteResult === 'missing') return jsonError('附件不存在或不属于当前会话。', 404);
      conversationDeleted = await deleteEmptyChatConversationOwnedBy(
        conversationId,
        auth.user!.id,
        RESEARCH_REVIEW_KIND
      );
    } finally {
      await finishConversationRun(mutationLease).catch((error) => {
        console.error('[research-review] failed to release attachment-delete lease', error);
      });
    }
    await notifyChatConversationChanged({
      userId: auth.user!.id,
      conversationId,
      kind: RESEARCH_REVIEW_KIND,
      action: conversationDeleted ? 'delete' : 'upsert',
      resource: 'attachments'
    });
    return NextResponse.json({ ok: true, conversationDeleted });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '删除附件失败。', 500);
  }
}
