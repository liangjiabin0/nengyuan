import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAttachmentAbsolutePath, type ChatAttachmentRow } from '@/lib/chat-attachments';
import { normalizeFormulaSyntax, wrapLongMarkdownLines } from '@/lib/corpus/export';
import { getCorpusRoot } from '@/lib/corpus/schema';
import type { OpenCodeAttachment } from '@/lib/opencode/attachments';
import { attachmentNeedsDocumentReader } from './document-reader';
import { convertAttachmentDocument } from './markitdown-cli';
import { classifyAttachmentKind } from './program-package';

export type AttachmentWorkspaceProgress = {
  phase: string;
  detail: string;
};

function parseRowMetadata(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function yamlScalar(value: unknown) {
  if (value === null || value === undefined || value === '') return 'null';
  return JSON.stringify(String(value).replace(/\r?\n/g, ' '));
}

function safeSegment(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** Virtual Markdown cache for a conversation under knowledge-corpus/attachments/. */
export function conversationAttachmentCacheDir(conversationId: string) {
  return path.join(getCorpusRoot(), 'attachments', safeSegment(conversationId.trim()));
}

function sanitizeFileStem(value: string) {
  const stem = path.basename(value, path.extname(value))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (stem || 'file').slice(0, 72);
}

function readExistingSourceHash(filePath: string) {
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 1200);
    const match = head.match(/source_hash:\s*"([a-f0-9]+)"/i)
      || head.match(/source_hash:\s*([a-f0-9]+)/i);
    return match?.[1]?.toLowerCase() || '';
  } catch {
    return '';
  }
}

function originalWorkspaceName(summaryFileName: string, row: ChatAttachmentRow) {
  const ext = String(row.extension || path.extname(row.original_name) || '').toLowerCase() || '.bin';
  const base = summaryFileName.replace(/\.md$/i, '');
  return `${base}.orig${ext}`;
}

function copyOriginalAttachment(directory: string, fileName: string, row: ChatAttachmentRow) {
  try {
    const source = getAttachmentAbsolutePath(row);
    if (!fs.existsSync(source)) return '';
    const targetPath = path.join(directory, fileName);
    fs.copyFileSync(source, targetPath);
    return fileName;
  } catch {
    return '';
  }
}

/** 【按线上版本还原】Office/PDF 附件先自动转 Markdown；失败时在摘要里说明。 */
function buildAttachmentMarkdown(row: ChatAttachmentRow, convertNote?: string) {
  const body = convertNote
    ? [
      '系统未能把该 Office/PDF 转成 Markdown，不要把本说明当成正文，也不要假装已经读到原文。',
      '',
      convertNote
    ].join('\n')
    : row.extracted_text
      ? wrapLongMarkdownLines(normalizeFormulaSyntax(row.extracted_text))
      : '正文见同目录 `.converted.md`；没有转换稿时再读 `.orig.*`。不要把本说明当成原文。';
  return [
    '---',
    `record_key: ${yamlScalar(`attachment:${row.id}`)}`,
    `kind: ${yamlScalar('attachment')}`,
    `attachment_id: ${yamlScalar(row.id)}`,
    `conversation_id: ${yamlScalar(row.conversation_id)}`,
    `title: ${yamlScalar(row.original_name)}`,
    `source_file: ${yamlScalar(row.storage_path)}`,
    `source_hash: ${yamlScalar(row.sha256)}`,
    `content_hash: ${yamlScalar(row.sha256)}`,
    `updated_at: ${yamlScalar(row.updated_at)}`,
    '---',
    '',
    `# ${row.original_name.replace(/^#+\s*/, '')}`,
    '',
    body
  ].join('\n');
}

/**
 * Cache ready attachments as Markdown into a virtual directory for OpenCode agents.
 * - corpus mode: knowledge-corpus/attachments/<hash>/…（对话 / 指南默认）
 * - isolated mode: <root>/<subdir>/…（综述隔离工作区）
 */
export function cacheAttachmentsToVirtualDir(options: {
  conversationId: string;
  rows: ChatAttachmentRow[];
  mode?: 'corpus' | 'isolated';
  /** Required when mode === 'isolated' */
  rootDir?: string;
  subdir?: string;
  fileNameStyle?: 'hash' | 'ordered';
  onProgress?: (status: AttachmentWorkspaceProgress) => void;
}): { directory: string; attachmentPaths: OpenCodeAttachment[] } {
  const conversationId = options.conversationId.trim();
  const readyRows = options.rows.filter(
    (row) => row.conversation_id === conversationId && row.parse_status === 'ready'
  );
  const mode = options.mode || 'corpus';
  const subdir = options.subdir || 'attachments';
  const fileNameStyle = options.fileNameStyle || (mode === 'isolated' ? 'ordered' : 'hash');

  let directory: string;
  let relativePrefix: string;
  if (mode === 'isolated') {
    if (!options.rootDir) throw new Error('隔离工作区缺少 rootDir。');
    directory = path.join(options.rootDir, subdir);
    relativePrefix = subdir.replace(/\\/g, '/');
  } else {
    directory = path.join(getCorpusRoot(), 'attachments', safeSegment(conversationId));
    relativePrefix = path.posix.join('knowledge-corpus', 'attachments', safeSegment(conversationId));
  }
  fs.mkdirSync(directory, { recursive: true });

  const total = readyRows.length;
  options.onProgress?.({
    phase: 'workspace',
    detail: total ? `正在同步附件原文件到虚拟目录（0/${total}）…` : '本轮无附件，跳过缓存'
  });

  const usedNames = new Set<string>();
  const keepFiles = new Set<string>();
  let written = 0;
  let reused = 0;

  const attachmentPaths: OpenCodeAttachment[] = readyRows.map((row, index) => {
    let fileName: string;
    if (fileNameStyle === 'ordered') {
      const order = String(index + 1).padStart(2, '0');
      let stem = sanitizeFileStem(row.original_name);
      fileName = `${order}-${stem}.md`;
      while (usedNames.has(fileName.toLowerCase())) {
        stem = `${sanitizeFileStem(row.original_name)}-${safeSegment(row.id).slice(0, 6)}`;
        fileName = `${order}-${stem}.md`;
      }
    } else {
      fileName = `${safeSegment(row.id)}.md`;
    }
    usedNames.add(fileName.toLowerCase());
    keepFiles.add(fileName);

    const originalName = originalWorkspaceName(fileName, row);
    const copiedOriginal = copyOriginalAttachment(directory, originalName, row);
    if (copiedOriginal) keepFiles.add(copiedOriginal);

    const targetPath = path.join(directory, fileName);
    const relativePath = path.posix.join(relativePrefix, fileName);
    const originalRelativePath = copiedOriginal
      ? path.posix.join(relativePrefix, copiedOriginal)
      : undefined;
    let convertedRelativePath: string | undefined;
    let convertNote: string | undefined;
    let convertedThisRound = false;
    const sourceHash = String(row.sha256 || '').toLowerCase();
    const stubReusable = Boolean(
      sourceHash
      && fs.existsSync(targetPath)
      && readExistingSourceHash(targetPath) === sourceHash
    );
    if (copiedOriginal && attachmentNeedsDocumentReader(row)) {
      const convertedName = `${fileName.replace(/\.md$/i, '')}.converted.md`;
      const convertedPath = path.join(directory, convertedName);
      const convertedReusable = stubReusable
        && fs.existsSync(convertedPath)
        && fs.statSync(convertedPath).size > 20;
      if (convertedReusable) {
        keepFiles.add(convertedName);
        convertedRelativePath = path.posix.join(relativePrefix, convertedName);
      } else {
        convertedThisRound = true;
        options.onProgress?.({
          phase: 'workspace',
          detail: `正在把 ${row.original_name} 转成 Markdown（${index + 1}/${total}）…`
        });
        const converted = convertAttachmentDocument(
          path.join(directory, copiedOriginal),
          convertedPath
        );
        if (converted.ok) {
          keepFiles.add(convertedName);
          convertedRelativePath = path.posix.join(relativePrefix, convertedName);
        } else {
          convertNote = converted.error || '文档转换失败。';
          try {
            if (fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
          } catch {
            // ignore
          }
        }
      }
    } else if (copiedOriginal) {
      const convertedName = `${fileName.replace(/\.md$/i, '')}.converted.md`;
      const convertedPath = path.join(directory, convertedName);
      if (fs.existsSync(convertedPath) && fs.statSync(convertedPath).size > 20) {
        keepFiles.add(convertedName);
        convertedRelativePath = path.posix.join(relativePrefix, convertedName);
      }
    }
    if (stubReusable && !convertedThisRound) {
      reused += 1;
    } else {
      fs.writeFileSync(targetPath, `${buildAttachmentMarkdown(row, convertNote).trim()}\n`, 'utf8');
      written += 1;
    }

    if ((index + 1) % 8 === 0 || index + 1 === total) {
      options.onProgress?.({
        phase: 'workspace',
        detail: `正在同步附件到虚拟目录（${index + 1}/${total}，新建 ${written} · 复用 ${reused}）…`
      });
    }

    return {
      attachmentId: row.id,
      name: row.original_name,
      relativePath,
      originalRelativePath,
      convertedRelativePath,
      kind: classifyAttachmentKind({
        name: row.original_name,
        extension: row.extension,
        metadata: parseRowMetadata(row.metadata_json)
      })
    };
  });

  if (mode === 'isolated') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!keepFiles.has(entry.name)) {
        try {
          fs.unlinkSync(path.join(directory, entry.name));
        } catch {
          // ignore
        }
      }
    }
  }

  options.onProgress?.({
    phase: 'workspace_ready',
    detail: total
      ? `附件虚拟目录已就绪（${total} 个，新建 ${written} · 复用 ${reused}）`
      : '附件虚拟目录已就绪'
  });

  return { directory, attachmentPaths };
}

/** Absolute root for isolated attachment workspaces under storage/. */
export function attachmentWorkspaceRoot(scope: string, conversationId: string) {
  return path.join(process.cwd(), 'storage', scope, conversationId);
}
