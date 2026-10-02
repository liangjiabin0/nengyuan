import path from 'node:path';
import {
  storeChatAttachment,
  type ChatAttachment
} from '@/lib/chat-attachments';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PARSE_EXTENSION_SET,
  ATTACHMENT_UPLOAD_EXTENSION_SET
} from './policy';

export type AttachmentUploadResult = {
  attachments: Array<ChatAttachment & { deduplicated?: boolean; sourceZip?: string }>;
  failed: Array<{ name: string; error: string }>;
  /** Always 0: ZIP is stored as-is; the agent decides whether to extract. */
  extractedFromZip: number;
};

function extensionOf(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

/**
 * Unified upload entry: store the original file only.
 * Do not unzip archives or parse documents here; the agent decides how to handle them.
 */
export async function storeAttachmentUpload(
  conversationId: string,
  input: { name: string; type?: string; buffer: Buffer },
  options: {
    previewApiBase?: string;
    allowedExtensions?: Set<string>;
    parseExtensions?: Set<string>;
    allowAnyExtension?: boolean;
  } = {}
): Promise<AttachmentUploadResult> {
  const previewApiBase = options.previewApiBase || '/api/chat';
  const allowedExtensions = options.allowedExtensions || ATTACHMENT_UPLOAD_EXTENSION_SET;
  const parseExtensions = options.parseExtensions || ATTACHMENT_PARSE_EXTENSION_SET;
  const allowAnyExtension = Boolean(options.allowAnyExtension);
  const originalName = path.basename(input.name || 'attachment').trim() || 'attachment';
  const extension = extensionOf(originalName);
  if (!allowAnyExtension && !allowedExtensions.has(extension)) {
    throw new Error(
      `仅支持 ${[...parseExtensions].join('、')} 或 ZIP；压缩包与文档均原样保存，由助手决定如何处理。`
    );
  }
  if (!input.buffer.length) throw new Error('不能上传空文件。');
  if (input.buffer.length > ATTACHMENT_MAX_BYTES) {
    throw new Error('单个附件不能超过 200 MB。');
  }

  const result = await storeChatAttachment(
    conversationId,
    { name: originalName, type: input.type, buffer: input.buffer },
    {
      maxBytes: ATTACHMENT_MAX_BYTES,
      allowedExtensions,
      allowAnyExtension,
      deferToAgent: true,
      previewApiBase
    }
  );
  return {
    attachments: [{ ...result.attachment, deduplicated: result.deduplicated }],
    failed: [],
    extractedFromZip: 0
  };
}
