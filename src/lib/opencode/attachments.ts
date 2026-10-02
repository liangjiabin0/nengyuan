import type { ChatAttachmentRow } from '../chat-attachments';
import { cacheAttachmentsToVirtualDir } from '@/lib/attachments/workspace-cache';

export type OpenCodeAttachment = {
  attachmentId: string;
  name: string;
  relativePath: string;
  originalRelativePath?: string;
  convertedRelativePath?: string;
  kind?: 'document' | 'inventory' | 'program' | 'binary' | 'text' | 'archive';
};

export function attachmentAgentPath(item: OpenCodeAttachment) {
  return item.convertedRelativePath || item.originalRelativePath || item.relativePath;
}

/** Cache attachments into knowledge-corpus/attachments virtual directory. */
export function writeOpenCodeAttachments(
  conversationId: string,
  rows: ChatAttachmentRow[]
): OpenCodeAttachment[] {
  if (!rows.length) return [];
  const { attachmentPaths } = cacheAttachmentsToVirtualDir({
    conversationId,
    rows,
    mode: 'corpus',
    fileNameStyle: 'hash'
  });
  return attachmentPaths;
}
