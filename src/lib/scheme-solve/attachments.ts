import {
  deleteConversationAttachments,
  listChatAttachmentRows,
  listChatAttachments,
  remapAttachmentPreviewBase,
  type ChatAttachment,
  type ChatAttachmentRow
} from '@/lib/chat-attachments';
import { storeAttachmentUpload } from '@/lib/attachments/upload';
import { writeOpenCodeAttachments, type OpenCodeAttachment } from '@/lib/opencode/attachments';
import {
  SCHEME_SOLVE_ALLOWED_EXTENSIONS,
  SCHEME_SOLVE_API_BASE,
  SCHEME_SOLVE_PARSE_EXTENSIONS
} from './constants';

export async function listSchemeSolveAttachments(sessionId: string): Promise<ChatAttachment[]> {
  const attachments = await listChatAttachments(sessionId);
  return attachments.map((attachment) => remapAttachmentPreviewBase(attachment, SCHEME_SOLVE_API_BASE));
}

export async function listReadySchemeSolveAttachmentRows(sessionId: string): Promise<ChatAttachmentRow[]> {
  const rows = await listChatAttachmentRows(sessionId);
  return rows.filter((row) => row.parse_status === 'ready');
}

export async function storeSchemeSolveAttachment(
  sessionId: string,
  input: { name: string; type?: string; buffer: Buffer }
) {
  return storeAttachmentUpload(sessionId, input, {
    previewApiBase: SCHEME_SOLVE_API_BASE,
    allowedExtensions: SCHEME_SOLVE_ALLOWED_EXTENSIONS,
    parseExtensions: SCHEME_SOLVE_PARSE_EXTENSIONS
  });
}

export async function deleteSchemeSolveAttachments(sessionId: string) {
  return deleteConversationAttachments(sessionId);
}

export function cacheSchemeSolveAttachmentsForOpenCode(
  sessionId: string,
  rows: ChatAttachmentRow[]
): OpenCodeAttachment[] {
  return writeOpenCodeAttachments(sessionId, rows);
}
