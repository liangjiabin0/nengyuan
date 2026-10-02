import {
  deleteChatAttachment,
  listChatAttachments,
  remapAttachmentPreviewBase,
  type ChatAttachment
} from '@/lib/chat-attachments';
import { storeAttachmentUpload } from '@/lib/attachments/upload';
import { RESEARCH_REVIEW_API_BASE } from './constants';

export type ResearchReviewUploadResult = {
  attachments: Array<ChatAttachment & { deduplicated?: boolean; sourceZip?: string }>;
  failed: Array<{ name: string; error: string }>;
  extractedFromZip: number;
};

export async function storeResearchReviewUpload(
  conversationId: string,
  input: { name: string; type?: string; buffer: Buffer }
): Promise<ResearchReviewUploadResult> {
  return storeAttachmentUpload(conversationId, input, {
    previewApiBase: RESEARCH_REVIEW_API_BASE
  });
}

export async function listResearchReviewAttachments(conversationId: string, messageId?: string) {
  const attachments = await listChatAttachments(conversationId, messageId);
  return attachments.map((attachment) => remapAttachmentPreviewBase(attachment, RESEARCH_REVIEW_API_BASE));
}

export async function deleteResearchReviewAttachment(conversationId: string, attachmentId: string) {
  return deleteChatAttachment(conversationId, attachmentId);
}
