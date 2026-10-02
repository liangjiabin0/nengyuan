import { NextResponse } from 'next/server';
import { assertConversationOwner } from '@/lib/chat-history';
import {
  getResearchReviewArtifact,
  getResearchReviewArtifactFile
} from '@/lib/research-review/artifacts';
import { RESEARCH_REVIEW_KIND } from '@/lib/research-review/constants';
import { requireUser } from '@/lib/auth/request';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function contentDisposition(fileName: string) {
  // ASCII filename 仅作旧客户端兜底；真实中文名走 filename*
  const ascii = 'AI4ES-Research-Review.docx';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireUser(_request);
    if (auth.error) return auth.error;
    const { id } = await params;
    const artifact = await getResearchReviewArtifact(id);
    if (!artifact) return jsonError('附件不存在。', 404);

    const ownership = await assertConversationOwner(
      artifact.conversationId,
      auth.user!.id,
      RESEARCH_REVIEW_KIND
    );
    if (!ownership.conversation) return jsonError('会话不存在。', 404);
    if (!ownership.allowed) return jsonError('无权访问该附件。', 403);

    const file = await getResearchReviewArtifactFile(id);
    if (!file) return jsonError('附件文件已丢失。', 404);
    if (file.artifact.conversationId !== artifact.conversationId) {
      return jsonError('会话状态已发生变化，请刷新后重试。', 409);
    }
    const currentOwnership = await assertConversationOwner(
      artifact.conversationId,
      auth.user!.id,
      RESEARCH_REVIEW_KIND
    );
    if (!currentOwnership.conversation || !currentOwnership.allowed) {
      return jsonError('会话状态已发生变化，请刷新后重试。', 409);
    }

    return new NextResponse(file.bytes, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': contentDisposition(file.artifact.fileName),
        'Cache-Control': 'no-store',
        'Content-Length': String(file.bytes.length)
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '下载失败。', 500);
  }
}
