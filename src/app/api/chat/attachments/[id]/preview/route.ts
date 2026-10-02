import fs from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { getAttachmentAbsolutePath, getChatAttachmentRow } from '@/lib/chat-attachments';
import { assertConversationOwner } from '@/lib/chat-history';
import { requireUser } from '@/lib/auth/request';

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
    const inline = url.searchParams.get('inline') === '1';
    if (!conversationId) return jsonError('缺少 conversationId。');
    const ownership = await assertConversationOwner(conversationId, auth.user!.id, 'chat');
    if (!ownership.conversation) return jsonError('会话不存在。', 404);
    if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
    const attachment = await getChatAttachmentRow(conversationId, id);
    if (!attachment) return jsonError('附件不存在或不属于当前会话。', 404);
    if (attachment.parse_status !== 'ready') return jsonError('附件尚未解析完成。', 409);

    const extension = String(attachment.extension || '').toLowerCase();
    const originalName = String(attachment.original_name || '').toLowerCase();
    const mediaType = String(attachment.media_type || '').toLowerCase();
    const isImage = mediaType.startsWith('image/')
      || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(extension)
      || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(originalName);
    const isHtml = extension === '.html' || extension === '.htm'
      || mediaType === 'text/html'
      || mediaType === 'application/xhtml+xml';
    if (download || extension === '.pdf' || isImage || (inline && isHtml)) {
      const bytes = await fs.readFile(getAttachmentAbsolutePath(attachment));
      const currentOwnership = await assertConversationOwner(conversationId, auth.user!.id, 'chat');
      if (!currentOwnership.conversation || !currentOwnership.allowed) {
        return jsonError('会话状态已发生变化，请刷新后重试。', 409);
      }
      const imageType = mediaType.startsWith('image/')
        ? attachment.media_type
        : extension === '.svg' || originalName.endsWith('.svg')
          ? 'image/svg+xml'
          : extension === '.jpg' || extension === '.jpeg' || originalName.endsWith('.jpg') || originalName.endsWith('.jpeg')
            ? 'image/jpeg'
            : `image/${(extension.replace('.', '') || 'png')}`;
      return new NextResponse(Uint8Array.from(bytes), {
        headers: {
          'Content-Type': isImage ? imageType : isHtml ? 'text/html; charset=utf-8' : attachment.media_type,
          'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', attachment.original_name),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(isHtml && !download
            ? {
                // Render reports in a same-origin iframe without allowing the
                // attachment to execute scripts or navigate the parent page.
                'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:"
              }
            : {})
        }
      });
    }

    const currentOwnership = await assertConversationOwner(conversationId, auth.user!.id, 'chat');
    if (!currentOwnership.conversation || !currentOwnership.allowed) {
      return jsonError('会话状态已发生变化，请刷新后重试。', 409);
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
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return jsonError('附件文件不存在。', 404);
    return jsonError(error instanceof Error ? error.message : '附件预览失败。', 500);
  }
}
