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
  GRID_GUIDE_ATTACHMENT_API_BASE,
  GRID_GUIDE_ATTACHMENT_MAX_BYTES,
  GRID_GUIDE_ATTACHMENT_MAX_FILES
} from './constants';

export {
  GRID_GUIDE_ATTACHMENT_API_BASE,
  GRID_GUIDE_ATTACHMENT_MAX_BYTES,
  GRID_GUIDE_ATTACHMENT_MAX_FILES
} from './constants';

export async function listGridGuideAttachments(projectId: string): Promise<ChatAttachment[]> {
  const attachments = await listChatAttachments(projectId);
  return attachments.map((attachment) =>
    remapAttachmentPreviewBase(attachment, GRID_GUIDE_ATTACHMENT_API_BASE)
  );
}

export async function listReadyGridGuideAttachmentRows(projectId: string): Promise<ChatAttachmentRow[]> {
  const rows = await listChatAttachmentRows(projectId);
  return rows.filter((row) => row.parse_status === 'ready');
}

export async function storeGridGuideAttachment(
  projectId: string,
  input: { name: string; type?: string; buffer: Buffer }
) {
  return storeAttachmentUpload(projectId, input, {
    previewApiBase: GRID_GUIDE_ATTACHMENT_API_BASE
  });
}

export async function deleteGridGuideAttachments(projectId: string) {
  return deleteConversationAttachments(projectId);
}

export function cacheGridGuideAttachmentsForOpenCode(
  projectId: string,
  rows: ChatAttachmentRow[]
): OpenCodeAttachment[] {
  return writeOpenCodeAttachments(projectId, rows);
}

export function formatGridGuideAttachmentPromptBlock(paths: OpenCodeAttachment[]) {
  if (!paths.length) return '';
  return `用户上传的参考附件已按原样放入工作区（未解压、未预解析）。设计时请按任务自行决定是否解压或转换后再吸收约束（正式正文仍禁止写入路径、文件名或引用标记）：
${paths.map((item) => `- ${item.name}: ${item.originalRelativePath || item.relativePath}`).join('\n')}`;
}
