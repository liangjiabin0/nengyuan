import { NextResponse } from 'next/server';
import { assertConversationOwner, getChatMessages } from '@/lib/chat-history';
import {
  getResearchReviewArtifactFile,
  readResearchReviewArtifactMarkdown
} from '@/lib/research-review/artifacts';
import { RESEARCH_REVIEW_KIND } from '@/lib/research-review/constants';
import { buildResearchReviewDocx, researchReviewFileName } from '@/lib/research-review/export';
import { requireUser } from '@/lib/auth/request';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function contentDisposition(fileName: string) {
  const ascii = 'AI4ES-Research-Review.docx';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => null);
    const conversationId = String(body?.conversationId || '').trim();
    const messageId = String(body?.messageId || '').trim();
    const artifactId = String(body?.artifactId || '').trim();
    if (!conversationId) return jsonError('缺少 conversationId。');

    const ownership = await assertConversationOwner(
      conversationId,
      auth.user!.id,
      RESEARCH_REVIEW_KIND
    );
    if (!ownership.conversation) return jsonError('会话不存在。', 404);
    if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
    const ownershipStillCurrent = async () => {
      const current = await assertConversationOwner(
        conversationId,
        auth.user!.id,
        RESEARCH_REVIEW_KIND
      );
      return Boolean(current.conversation && current.allowed);
    };

    if (artifactId) {
      const file = await getResearchReviewArtifactFile(artifactId);
      if (!file || file.artifact.conversationId !== conversationId) {
        return jsonError('附件不存在。', 404);
      }
      if (!await ownershipStillCurrent()) {
        return jsonError('会话状态已发生变化，请刷新后重试。', 409);
      }
      return new NextResponse(file.bytes, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': contentDisposition(file.artifact.fileName),
          'Cache-Control': 'no-store'
        }
      });
    }

    const messages = await getChatMessages(conversationId);
    let target = messageId
      ? messages.find((message) => message.id === messageId && message.role === 'assistant')
      : undefined;
    if (!target) {
      target = [...messages].reverse().find((message) => message.role === 'assistant');
    }
    if (!target) return jsonError('没有可导出的综述正文。', 404);

    const existing = target.artifacts?.[0];
    if (existing) {
      const file = await getResearchReviewArtifactFile(existing.id);
      if (file) {
        if (!await ownershipStillCurrent()) {
          return jsonError('会话状态已发生变化，请刷新后重试。', 409);
        }
        return new NextResponse(file.bytes, {
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': contentDisposition(file.artifact.fileName),
            'Cache-Control': 'no-store'
          }
        });
      }
    }

    const storedMarkdown = await readResearchReviewArtifactMarkdown(target.id, conversationId);
    const markdown = storedMarkdown.trim() || target.content.trim();
    if (!markdown) return jsonError('没有可导出的综述正文。', 404);

    const title = ownership.conversation.title || '科研综述';
    const bytes = await buildResearchReviewDocx(markdown, title);
    const fileName = researchReviewFileName(title);
    if (!await ownershipStillCurrent()) {
      return jsonError('会话状态已发生变化，请刷新后重试。', 409);
    }
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': contentDisposition(fileName),
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '导出失败。', 500);
  }
}
