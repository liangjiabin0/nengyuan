import fs from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { getAttachmentAbsolutePath, getChatAttachmentRow } from '@/lib/chat-attachments';
import { assertGridGuideOwner } from '@/lib/grid-guide/store';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function contentDisposition(kind: 'inline' | 'attachment', fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { id } = await params;
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversationId')?.trim() || '';
    const download = url.searchParams.get('download') === '1';
    if (!conversationId) return jsonError('缺少 conversationId。');

    const ownership = await assertGridGuideOwner(conversationId, auth.user!.id);
    if (!ownership.exists) return jsonError('项目指南不存在。', 404);
    if (!ownership.allowed) return jsonError('无权访问该项目指南。', 403);

    const attachment = await getChatAttachmentRow(conversationId, id);
    if (!attachment) return jsonError('附件不存在或不属于当前项目。', 404);
    if (attachment.parse_status !== 'ready') return jsonError('附件尚未解析完成。', 409);

    if (download || attachment.extension === '.pdf') {
      const bytes = await fs.readFile(getAttachmentAbsolutePath(attachment));
      return new NextResponse(bytes, {
        headers: {
          'Content-Type': attachment.media_type,
          'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', attachment.original_name),
          'Cache-Control': 'private, max-age=120',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }

    return NextResponse.json({
      kind: attachment.extension === '.md' ? 'markdown' : 'text',
      title: attachment.original_name,
      fileName: attachment.original_name,
      content: (attachment.extracted_text || '').slice(0, 500_000),
      attachmentId: attachment.id,
      conversationId: attachment.conversation_id,
      mediaType: attachment.media_type
    }, {
      headers: {
        'Cache-Control': 'private, max-age=120',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return jsonError('附件文件不存在。', 404);
    return jsonError(error instanceof Error ? error.message : '附件预览失败。', 500);
  }
}
