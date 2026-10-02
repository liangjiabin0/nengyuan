import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { all, get, run, withTransaction } from './db';
import { hasAttachmentFts } from './fts-index';
import { splitTextIntoParentChildChunks } from './parent-chunk';
import { lockConversationQueueMutation } from './chat-run-registry';

import {
  ATTACHMENT_IMAGE_EXTENSION_SET,
  ATTACHMENT_MAX_BIND_FILES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_UPLOAD_FILES,
  ATTACHMENT_PARSE_EXTENSION_SET
} from '@/lib/attachments/policy';
import { summarizeMathProg } from '@/lib/attachments/math-prog';

/** @deprecated Use ATTACHMENT_MAX_UPLOAD_FILES — kept as alias for existing imports. */
export const CHAT_ATTACHMENT_MAX_FILES = ATTACHMENT_MAX_UPLOAD_FILES;
/** @deprecated Use ATTACHMENT_MAX_BYTES */
export const CHAT_ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const CHAT_ATTACHMENT_MAX_BIND_FILES = ATTACHMENT_MAX_BIND_FILES;
export const CHAT_ATTACHMENT_ROOT = path.join(process.cwd(), 'storage', 'attachments');

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 5_000;
const MAX_COLUMNS = 100;
const ALLOWED_EXTENSIONS = ATTACHMENT_PARSE_EXTENSION_SET;
const TEXT_LIKE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.log',
  '.rtf',
  '.json',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.tex',
  '.bib',
  '.csv',
  '.tsv',
  '.m',
  '.mps',
  '.lp',
  '.py',
  '.ipynb',
  '.js',
  '.ts',
  '.r',
  '.jl',
  '.sh',
  '.ps1'
]);
const IMAGE_EXTENSIONS = ATTACHMENT_IMAGE_EXTENSION_SET;
const ALLOWED_MEDIA_TYPES: Record<string, Set<string>> = {
  '.pdf': new Set(['application/pdf', 'application/octet-stream']),
  '.docx': new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream'
  ]),
  '.md': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
  '.markdown': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
  '.txt': new Set(['text/plain', 'application/octet-stream']),
  '.log': new Set(['text/plain', 'application/octet-stream']),
  '.rtf': new Set(['application/rtf', 'text/rtf', 'text/plain', 'application/octet-stream']),
  '.json': new Set(['application/json', 'text/json', 'text/plain', 'application/octet-stream']),
  '.html': new Set(['text/html', 'application/xhtml+xml', 'application/octet-stream']),
  '.htm': new Set(['text/html', 'application/xhtml+xml', 'application/octet-stream']),
  '.xml': new Set(['application/xml', 'text/xml', 'application/octet-stream']),
  '.yaml': new Set(['text/yaml', 'application/yaml', 'text/plain', 'application/octet-stream']),
  '.yml': new Set(['text/yaml', 'application/yaml', 'text/plain', 'application/octet-stream']),
  '.tex': new Set(['application/x-tex', 'text/x-tex', 'text/plain', 'application/octet-stream']),
  '.bib': new Set(['text/plain', 'application/x-bibtex', 'application/octet-stream']),
  '.xlsx': new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/octet-stream'
  ]),
  '.xls': new Set(['application/vnd.ms-excel', 'application/octet-stream']),
  '.csv': new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream']),
  '.tsv': new Set(['text/tab-separated-values', 'text/plain', 'text/csv', 'application/octet-stream']),
  '.m': new Set(['text/plain', 'text/x-matlab', 'application/octet-stream']),
  '.mps': new Set(['text/plain', 'application/x-mps', 'application/octet-stream']),
  '.lp': new Set(['text/plain', 'application/x-lp', 'application/octet-stream']),
  '.mat': new Set(['application/octet-stream', 'application/x-matlab-data']),
  '.png': new Set(['image/png', 'application/octet-stream']),
  '.jpg': new Set(['image/jpeg', 'application/octet-stream']),
  '.jpeg': new Set(['image/jpeg', 'application/octet-stream']),
  '.gif': new Set(['image/gif', 'application/octet-stream']),
  '.webp': new Set(['image/webp', 'application/octet-stream']),
  '.bmp': new Set(['image/bmp', 'image/x-ms-bmp', 'application/octet-stream']),
  '.svg': new Set(['image/svg+xml', 'text/xml', 'application/xml', 'application/octet-stream']),
  '.py': new Set(['text/x-python', 'text/plain', 'application/octet-stream']),
  '.ipynb': new Set(['application/x-ipynb+json', 'application/json', 'text/plain', 'application/octet-stream']),
  '.js': new Set(['text/javascript', 'application/javascript', 'text/plain', 'application/octet-stream']),
  '.ts': new Set(['text/typescript', 'application/typescript', 'text/plain', 'application/octet-stream']),
  '.r': new Set(['text/x-r', 'text/plain', 'application/octet-stream']),
  '.jl': new Set(['text/x-julia', 'text/plain', 'application/octet-stream']),
  '.sh': new Set(['text/x-sh', 'application/x-sh', 'text/plain', 'application/octet-stream']),
  '.ps1': new Set(['text/plain', 'application/octet-stream']),
  '.bat': new Set(['text/plain', 'application/octet-stream']),
  '.cmd': new Set(['text/plain', 'application/octet-stream']),
  '.zip': new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])
};

export type ChatAttachmentStatus = 'processing' | 'ready' | 'failed';

export type ChatAttachmentRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  original_name: string;
  stored_name: string;
  storage_path: string;
  media_type: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  parse_status: ChatAttachmentStatus;
  parse_error: string | null;
  extracted_text: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatAttachment = {
  id: string;
  conversationId: string;
  messageId?: string;
  name: string;
  mediaType: string;
  extension: string;
  size: number;
  status: ChatAttachmentStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  previewUrl: string;
  downloadUrl: string;
  createdAt: string;
};

export type AttachmentSearchResult = {
  chunkId: string;
  attachmentId: string;
  fileName: string;
  section: string;
  text: string;
  score: number;
};

type UploadInput = {
  name: string;
  type?: string;
  buffer: Buffer;
};

export type StoreChatAttachmentOptions = {
  maxBytes?: number;
  allowedExtensions?: Set<string>;
  /** Skip extension allow-list; keep the original file for the agent to inspect. */
  allowAnyExtension?: boolean;
  /** Let the Agent parse the original later instead of extracting preview text now. */
  deferToAgent?: boolean;
  previewApiBase?: string;
  extraMetadata?: Record<string, unknown>;
};

export type BindChatAttachmentOptions = {
  maxFiles?: number;
};

type ParsedAttachment = {
  text: string;
  mediaType: string;
  metadata: Record<string, unknown>;
};

function safeConversationId(value: string) {
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(id)) {
    throw new Error('无效的会话 ID。');
  }
  return id;
}

function sanitizeFileName(value: string) {
  const name = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (name || 'attachment').slice(0, 240);
}

function resolveInsideAttachmentRoot(...parts: string[]) {
  const root = path.resolve(CHAT_ATTACHMENT_ROOT);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('附件路径超出允许范围。');
  }
  return target;
}

function extensionOf(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

function isZip(buffer: Buffer) {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && [0x03, 0x05, 0x07].includes(buffer[2])
    && [0x04, 0x06, 0x08].includes(buffer[3]);
}

function isOle(buffer: Buffer) {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);
}

function looksLikeText(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length === 0 || suspicious / sample.length < 0.02;
}

function validateSignature(extension: string, buffer: Buffer) {
  if (extension === '.pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('文件内容不是有效的 PDF，扩展名可能被伪造。');
  }
  if ((extension === '.docx' || extension === '.xlsx') && !isZip(buffer)) {
    throw new Error('Office 文件签名无效，扩展名可能被伪造。');
  }
  if (extension === '.xls' && !isOle(buffer)) {
    throw new Error('XLS 文件签名无效，扩展名可能被伪造。');
  }
  if (TEXT_LIKE_EXTENSIONS.has(extension) && !looksLikeText(buffer)) {
    throw new Error('文本文件包含二进制内容，扩展名可能被伪造。');
  }
  if (extension === '.png' && !hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    throw new Error('PNG 文件签名无效，扩展名可能被伪造。');
  }
  if ((extension === '.jpg' || extension === '.jpeg') && !hasPrefix(buffer, [0xff, 0xd8, 0xff])) {
    throw new Error('JPEG 文件签名无效，扩展名可能被伪造。');
  }
  if (extension === '.gif' && !isGif(buffer)) {
    throw new Error('GIF 文件签名无效，扩展名可能被伪造。');
  }
  if (extension === '.webp' && !isWebp(buffer)) {
    throw new Error('WEBP 文件签名无效，扩展名可能被伪造。');
  }
  if (extension === '.bmp' && !hasPrefix(buffer, [0x42, 0x4d])) {
    throw new Error('BMP 文件签名无效，扩展名可能被伪造。');
  }
  if (extension === '.svg' && !looksLikeText(buffer)) {
    throw new Error('SVG 文件包含二进制内容，扩展名可能被伪造。');
  }
  if (extension === '.zip' && !isZip(buffer)) {
    throw new Error('ZIP 文件签名无效，扩展名可能被伪造。');
  }
}

function hasPrefix(buffer: Buffer, signature: number[]) {
  return buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);
}

function isGif(buffer: Buffer) {
  const header = buffer.subarray(0, 6).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
}

function isWebp(buffer: Buffer) {
  return hasPrefix(buffer, [0x52, 0x49, 0x46, 0x46])
    && buffer.length >= 12
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function validateMediaType(extension: string, mediaType?: string) {
  const normalized = String(mediaType || '').split(';', 1)[0].trim().toLowerCase();
  if (!normalized) return;
  const allowed = ALLOWED_MEDIA_TYPES[extension];
  if (!allowed) return;
  if (!allowed.has(normalized)) {
    throw new Error(`文件 MIME 类型 ${normalized} 与 ${extension} 扩展名不匹配。`);
  }
}

function imageMediaType(extension: string) {
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function normalizeExtractedText(value: string) {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function parsePdf(buffer: Buffer): Promise<ParsedAttachment> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    const text = normalizeExtractedText(textResult.text || '');
    const pageCount = Number((textResult as { total?: number }).total || 0);
    if (text.length < 20) {
      throw new Error('PDF 未提取到足够文本，可能是扫描版；当前暂不支持 OCR。');
    }
    return { text, mediaType: 'application/pdf', metadata: { pageCount } };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function parseDocx(buffer: Buffer): Promise<ParsedAttachment> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  const text = normalizeExtractedText(result.value);
  if (!text) throw new Error('DOCX 未提取到文本。');
  return {
    text,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    metadata: { warnings: result.messages.map((message) => message.message).slice(0, 20) }
  };
}

function renderRows(sheetName: string, rows: unknown[][]) {
  const selected = rows.slice(0, MAX_ROWS_PER_SHEET);
  const rendered = selected.map((row, index) => {
    const cells = row.slice(0, MAX_COLUMNS).map((cell) => String(cell ?? '').replace(/\s+/g, ' ').trim());
    return `第 ${index + 1} 行 | ${cells.join(' | ')}`;
  });
  return `## 工作表：${sheetName}\n\n${rendered.join('\n')}`;
}

function parseWorkbook(buffer: Buffer, extension: '.xlsx' | '.xls'): ParsedAttachment {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw new Error(`${extension.toUpperCase()} 文件无法解析，文件可能损坏或扩展名被伪造。`);
  }
  const sheetNames = workbook.SheetNames.slice(0, MAX_SHEETS);
  const sections = sheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false });
    return renderRows(sheetName, rows);
  });
  const text = normalizeExtractedText(sections.join('\n\n'));
  if (!text) throw new Error('表格未包含可读取的单元格。');
  return {
    text,
    mediaType: extension === '.xls'
      ? 'application/vnd.ms-excel'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    metadata: {
      sheetNames,
      truncatedSheets: workbook.SheetNames.length > MAX_SHEETS,
      maxRowsPerSheet: MAX_ROWS_PER_SHEET
    }
  };
}

function parseDelimitedFile(buffer: Buffer, extension: '.csv' | '.tsv'): ParsedAttachment {
  const source = normalizeExtractedText(buffer.toString('utf8'));
  let rows: unknown[][];
  try {
    rows = parseCsv(source, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      delimiter: extension === '.tsv' ? '\t' : undefined,
      to: MAX_ROWS_PER_SHEET
    }) as unknown[][];
  } catch {
    throw new Error(`${extension.toUpperCase()} 文件无法解析，请确认编码和分隔符格式。`);
  }
  const text = normalizeExtractedText(renderRows(extension.toUpperCase(), rows));
  if (!rows.length) throw new Error(`${extension.toUpperCase()} 未包含可读取的数据行。`);
  return {
    text,
    mediaType: extension === '.tsv' ? 'text/tab-separated-values' : 'text/csv',
    metadata: { rowCount: rows.length, maxRows: MAX_ROWS_PER_SHEET }
  };
}

function textMediaType(extension: string) {
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (extension === '.json') return 'application/json';
  if (extension === '.html' || extension === '.htm') return 'text/html';
  if (extension === '.xml') return 'application/xml';
  if (extension === '.yaml' || extension === '.yml') return 'text/yaml';
  if (extension === '.rtf') return 'application/rtf';
  return 'text/plain';
}

function originalFileStub(extension: string, buffer: Buffer, fileName = ''): ParsedAttachment {
  const label = fileName || (extension ? `file${extension}` : 'attachment');
  return {
    text: normalizeExtractedText(
      `附件原文件（${label}，${buffer.length} 字节）已放入工作区。请按类型自行决定如何读取：纯文本直接 read 原文件；PDF/Word/PPT/Excel 等不能直接 read 的格式按文档读取技能转换后再读。不要只复述这段说明。`
    ),
    mediaType: declaredMediaType(extension),
    metadata: { deferredParse: true, byteLength: buffer.length, originalName: label }
  };
}

function declaredMediaType(extension: string) {
  if (IMAGE_EXTENSIONS.has(extension)) return imageMediaType(extension);
  const extras: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.epub': 'application/epub+zip',
    '.rtf': 'application/rtf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.zip': 'application/zip'
  };
  if (extras[extension]) return extras[extension];
  const allowed = ALLOWED_MEDIA_TYPES[extension];
  if (allowed) {
    for (const type of allowed) {
      if (type !== 'application/octet-stream') return type;
    }
  }
  if (TEXT_LIKE_EXTENSIONS.has(extension)) return textMediaType(extension);
  return 'application/octet-stream';
}

function binaryStub(extension: string, buffer: Buffer, fileName = ''): ParsedAttachment {
  const label = fileName || (extension ? `file${extension}` : 'attachment');
  return {
    text: normalizeExtractedText(
      `二进制附件（${label}，${buffer.length} 字节）。原文件已放入工作区，请按类型自行 read / 解析 / 处理，不要只复述这段说明。`
    ),
    mediaType: 'application/octet-stream',
    metadata: { binary: true, byteLength: buffer.length, originalName: label }
  };
}

async function parseAttachment(
  extension: string,
  buffer: Buffer,
  fileName = '',
  options: { deferToAgent?: boolean } = {}
): Promise<ParsedAttachment> {
  if (options.deferToAgent) {
    if (IMAGE_EXTENSIONS.has(extension)) {
      try {
        validateSignature(extension, buffer);
        return {
          text: normalizeExtractedText(
            `图片附件（${extension}，${buffer.length} 字节）。原图已作为视觉输入提交，请结合图像内容回答，不要只复述这段说明。`
          ),
          mediaType: imageMediaType(extension),
          metadata: { binary: true, image: true, byteLength: buffer.length }
        };
      } catch {
        return originalFileStub(extension, buffer, fileName);
      }
    }
    if (extension === '.zip') {
      return {
        text: normalizeExtractedText(
          `压缩包（${fileName || 'archive.zip'}，${buffer.length} 字节）。系统未解压、未读取内部文件。原文件已放入工作区，请根据任务自行决定是否解压、读哪些条目、或保持打包。不要只复述这段说明。`
        ),
        mediaType: 'application/zip',
        metadata: { archive: true, byteLength: buffer.length, originalName: fileName }
      };
    }
    if (extension === '.mat') {
      const header = buffer.subarray(0, 128).toString('latin1').replace(/\0/g, ' ').trim();
      const text = normalizeExtractedText(
        `MATPOWER 二进制算例（.mat，${buffer.length} 字节）。\n${header || '无文本头'}\n此文件供 TDMG AC-OPF 直接读取，不展开矩阵。`
      );
      return {
        text,
        mediaType: 'application/octet-stream',
        metadata: { binary: true, byteLength: buffer.length }
      };
    }
    if (extension === '.mps' || extension === '.lp') {
      const summary = summarizeMathProg(buffer, extension, 'model');
      return {
        text: normalizeExtractedText(summary.text),
        mediaType: 'text/plain',
        metadata: {
          mathProg: true,
          format: summary.format,
          modelName: summary.name,
          rows: summary.rows,
          columns: summary.columns,
          integerColumns: summary.integerColumns,
          byteLength: summary.byteLength
        }
      };
    }
    return originalFileStub(extension, buffer, fileName);
  }
  if (extension === '.pdf') return parsePdf(buffer);
  if (extension === '.docx') return parseDocx(buffer);
  if (extension === '.xlsx' || extension === '.xls') return parseWorkbook(buffer, extension);
  if (extension === '.csv' || extension === '.tsv') return parseDelimitedFile(buffer, extension);
  if (IMAGE_EXTENSIONS.has(extension)) {
    try {
      validateSignature(extension, buffer);
      return {
        text: normalizeExtractedText(
          `图片附件（${extension}，${buffer.length} 字节）。原图已作为视觉输入提交，请结合图像内容回答，不要只复述这段说明。`
        ),
        mediaType: imageMediaType(extension),
        metadata: { binary: true, image: true, byteLength: buffer.length }
      };
    } catch {
      return binaryStub(extension, buffer, fileName);
    }
  }
  if (extension === '.mat') {
    const header = buffer.subarray(0, 128).toString('latin1').replace(/\0/g, ' ').trim();
    const text = normalizeExtractedText(
      `MATPOWER 二进制算例（.mat，${buffer.length} 字节）。\n${header || '无文本头'}\n此文件供 TDMG AC-OPF 直接读取，不展开矩阵。`
    );
    return {
      text,
      mediaType: 'application/octet-stream',
      metadata: { binary: true, byteLength: buffer.length }
    };
  }
  if (extension === '.mps' || extension === '.lp') {
    const summary = summarizeMathProg(buffer, extension, 'model');
    return {
      text: normalizeExtractedText(summary.text),
      mediaType: 'text/plain',
      metadata: {
        mathProg: true,
        format: summary.format,
        modelName: summary.name,
        rows: summary.rows,
        columns: summary.columns,
        integerColumns: summary.integerColumns,
        byteLength: summary.byteLength
      }
    };
  }
  const text = normalizeExtractedText(buffer.toString('utf8'));
  if (text && (TEXT_LIKE_EXTENSIONS.has(extension) || looksLikeText(buffer))) {
    return {
      text,
      mediaType: textMediaType(extension),
      metadata: { characterCount: text.length }
    };
  }
  return binaryStub(extension, buffer, fileName);
}

function attachmentPreviewUrl(base: string, id: string, conversationId: string, mediaType: string, extension: string, fileName = '') {
  const image = String(mediaType || '').toLowerCase().startsWith('image/')
    || IMAGE_EXTENSIONS.has(String(extension || '').toLowerCase())
    || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName);
  const query = new URLSearchParams({ conversationId });
  if (image) query.set('inline', '1');
  return `${base}/attachments/${encodeURIComponent(id)}/preview?${query.toString()}`;
}

function attachmentDownloadUrl(base: string, id: string, conversationId: string) {
  const query = new URLSearchParams({ conversationId, download: '1' });
  return `${base}/attachments/${encodeURIComponent(id)}/preview?${query.toString()}`;
}

function parseAttachmentMetadata(value: string | null) {
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

function toPublicAttachment(row: ChatAttachmentRow, previewApiBase = '/api/chat'): ChatAttachment {
  const base = previewApiBase.replace(/\/$/, '') || '/api/chat';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id || undefined,
    name: row.original_name,
    mediaType: row.media_type,
    extension: row.extension,
    size: Number(row.size_bytes),
    status: row.parse_status,
    error: row.parse_error || undefined,
    metadata: parseAttachmentMetadata(row.metadata_json),
    previewUrl: attachmentPreviewUrl(base, row.id, row.conversation_id, row.media_type, row.extension, row.original_name),
    downloadUrl: attachmentDownloadUrl(base, row.id, row.conversation_id),
    createdAt: row.created_at
  };
}

export function isChatImageAttachment(extension: string, mediaType?: string) {
  const mime = String(mediaType || '').split(';', 1)[0].trim().toLowerCase();
  return mime.startsWith('image/') || IMAGE_EXTENSIONS.has(String(extension || '').toLowerCase());
}

export function chatAttachmentImagePaths(rows: ChatAttachmentRow[]) {
  return rows.flatMap((row) => {
    if (row.parse_status !== 'ready') return [];
    if (!isChatImageAttachment(row.extension, row.media_type)) return [];
    if (!row.storage_path) return [];
    const mime = String(row.media_type || '').split(';', 1)[0].trim().toLowerCase();
    return [{
      path: row.storage_path,
      name: row.original_name,
      mime: mime.startsWith('image/') ? mime : imageMediaType(row.extension)
    }];
  });
}

export function remapAttachmentPreviewBase(
  attachment: ChatAttachment,
  previewApiBase: string
): ChatAttachment {
  const base = previewApiBase.replace(/\/$/, '') || '/api/chat';
  return {
    ...attachment,
    previewUrl: attachmentPreviewUrl(base, attachment.id, attachment.conversationId, attachment.mediaType, attachment.extension, attachment.name),
    downloadUrl: attachmentDownloadUrl(base, attachment.id, attachment.conversationId)
  };
}

export async function getChatAttachment(conversationId: string, attachmentId: string) {
  const row = await get<ChatAttachmentRow>(
    'SELECT * FROM chat_attachments WHERE id = ? AND conversation_id = ?',
    [attachmentId, safeConversationId(conversationId)]
  );
  return row ? toPublicAttachment(row) : null;
}

export async function getChatAttachmentRow(conversationId: string, attachmentId: string) {
  return await get<ChatAttachmentRow>(
    'SELECT * FROM chat_attachments WHERE id = ? AND conversation_id = ?',
    [attachmentId, safeConversationId(conversationId)]
  ) || null;
}

export async function listChatAttachmentRows(conversationId: string, messageId?: string) {
  const id = safeConversationId(conversationId);
  return messageId
    ? await all<ChatAttachmentRow>(
        `SELECT a.*, b.message_id AS message_id
         FROM chat_message_attachments b
         JOIN chat_attachments a ON a.id = b.attachment_id AND a.conversation_id = b.conversation_id
         WHERE b.conversation_id = ? AND b.message_id = ?
         ORDER BY b.created_at, a.id`,
        [id, messageId]
      )
    : await all<ChatAttachmentRow>(
        'SELECT * FROM chat_attachments WHERE conversation_id = ? ORDER BY created_at, id',
        [id]
      );
}

export async function listChatAttachments(conversationId: string, messageId?: string) {
  const rows = await listChatAttachmentRows(conversationId, messageId);
  return rows.map((row) => toPublicAttachment(row));
}

export async function listChatAttachmentBindings(conversationId: string) {
  const id = safeConversationId(conversationId);
  const rows = await all<ChatAttachmentRow>(
    `SELECT a.*, b.message_id AS message_id
     FROM chat_message_attachments b
     JOIN chat_attachments a ON a.id = b.attachment_id AND a.conversation_id = b.conversation_id
     WHERE b.conversation_id = ?
     ORDER BY b.created_at, a.id`,
    [id]
  );
  return rows.map((row) => toPublicAttachment(row));
}

export async function storeChatAttachment(
  conversationId: string,
  input: UploadInput,
  options: StoreChatAttachmentOptions = {}
) {
  const id = safeConversationId(conversationId);
  const originalName = sanitizeFileName(input.name);
  const extension = extensionOf(originalName);
  const allowed = options.allowedExtensions || ALLOWED_EXTENSIONS;
  const maxBytes = options.maxBytes ?? CHAT_ATTACHMENT_MAX_BYTES;
  const previewApiBase = options.previewApiBase || '/api/chat';
  const allowAny = Boolean(options.allowAnyExtension);
  if (!allowAny && !allowed.has(extension)) {
    throw new Error('仅支持可解析文档或图片（PDF/DOCX/MD/TXT/表格/图片/JSON/HTML/XML 等）；不支持脚本或宏文件。');
  }
  if (!input.buffer.length) throw new Error('不能上传空文件。');
  if (input.buffer.length > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(`单个附件不能超过 ${mb} MB。`);
  }
  if (!allowAny) {
    validateMediaType(extension, input.type);
    validateSignature(extension, input.buffer);
  }

  const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex');
  const existing = await get<ChatAttachmentRow>(
    'SELECT * FROM chat_attachments WHERE conversation_id = ? AND sha256 = ?',
    [id, sha256]
  );
  if (existing?.parse_status === 'ready') {
    if (options.extraMetadata && Object.keys(options.extraMetadata).length) {
      const existingMetadata = parseAttachmentMetadata(existing.metadata_json) || {};
      const incomingRole = String(options.extraMetadata.role || '').toLowerCase();
      let belongsToUserMessage = false;
      if (
        (incomingRole === 'agent-deliverable' || incomingRole === 'generated-chart')
        && existing.message_id
      ) {
        const ownerMessage = await get<{ role: string }>(
          'SELECT role FROM chat_messages WHERE id = ? AND conversation_id = ?',
          [existing.message_id, id]
        );
        belongsToUserMessage = ownerMessage?.role === 'user';
      }
      // A generated file can have the same bytes as an uploaded input. Keep
      // the input's ownership and metadata so it never appears as AI output.
      const existingRole = String(existingMetadata.role || '').toLowerCase();
      const preserveGeneratedChartRole = existingRole === 'generated-chart' && incomingRole === 'agent-deliverable';
      const metadata = belongsToUserMessage
        ? existingMetadata
        : {
            ...existingMetadata,
            ...options.extraMetadata,
            ...(preserveGeneratedChartRole ? { role: 'generated-chart' } : {})
          };
      if (JSON.stringify(metadata) !== JSON.stringify(existingMetadata)) {
        await run(
          `UPDATE chat_attachments
           SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND conversation_id = ?`,
          [JSON.stringify(metadata), existing.id, id]
        );
        existing.metadata_json = JSON.stringify(metadata);
      }
    }
    return { attachment: toPublicAttachment(existing, previewApiBase), deduplicated: true };
  }

  const attachmentId = existing?.id || crypto.randomUUID();
  const storedName = `${attachmentId}${extension}`;
  const directory = resolveInsideAttachmentRoot(id);
  const storagePath = resolveInsideAttachmentRoot(id, storedName);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(storagePath, input.buffer, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });

  if (!existing) {
    await run(
      `INSERT INTO chat_attachments
       (id, conversation_id, original_name, stored_name, storage_path, media_type, extension, size_bytes, sha256, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')`,
      [attachmentId, id, originalName, storedName, storagePath, input.type || 'application/octet-stream', extension, input.buffer.length, sha256]
    );
  } else {
    await run(
      `UPDATE chat_attachments
       SET original_name = ?, storage_path = ?, parse_status = 'processing', parse_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND conversation_id = ?`,
      [originalName, storagePath, attachmentId, id]
    );
  }

  try {
    let parsed: ParsedAttachment;
    try {
      parsed = await parseAttachment(extension, input.buffer, originalName, {
        deferToAgent: options.deferToAgent ?? allowAny
      });
    } catch (error) {
      if (!allowAny) throw error;
      parsed = originalFileStub(extension, input.buffer, originalName);
    }
    const { parents, children } = splitTextIntoParentChildChunks(parsed.text, attachmentId);
    if (!children.length) throw new Error('附件未生成可检索文本块。');
    const metadata = {
      ...parsed.metadata,
      ...(options.extraMetadata || {})
    };
    await withTransaction(async (database) => {
      await database.prepare('DELETE FROM chat_attachment_chunks WHERE attachment_id = ? AND conversation_id = ?').run(attachmentId, id);
      const insertChunk = database.prepare(
        `INSERT INTO chat_attachment_chunks
         (id, attachment_id, conversation_id, chunk_index, section, text, token_estimate, parent_id, chunk_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const chunk of [...parents, ...children]) {
        await insertChunk.run(
          chunk.chunkKey,
          attachmentId,
          id,
          chunk.chunkIndex,
          chunk.section || '',
          chunk.text,
          chunk.tokenEstimate,
          chunk.parentKey,
          chunk.chunkRole
        );
      }
      await database.prepare(
        `UPDATE chat_attachments
         SET media_type = ?, parse_status = 'ready', parse_error = NULL, extracted_text = ?,
             metadata_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND conversation_id = ?`
      ).run(parsed.mediaType, parsed.text, JSON.stringify(metadata), attachmentId, id);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '附件解析失败。';
    await run(
      `UPDATE chat_attachments
       SET parse_status = 'failed', parse_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND conversation_id = ?`,
      [message, attachmentId, id]
    );
    await deleteChatAttachment(id, attachmentId);
    throw new Error(message);
  }

  const row = await getChatAttachmentRow(id, attachmentId);
  if (!row) throw new Error('附件保存后无法读取。');
  return { attachment: toPublicAttachment(row, previewApiBase), deduplicated: false };
}

export async function bindChatAttachmentsToMessage(
  conversationId: string,
  messageId: string,
  attachmentIds: string[],
  options: BindChatAttachmentOptions = {}
) {
  const id = safeConversationId(conversationId);
  const uniqueIds = [...new Set(attachmentIds)];
  const maxFiles = options.maxFiles ?? ATTACHMENT_MAX_BIND_FILES;
  if (uniqueIds.length > maxFiles) throw new Error(`每条消息最多附加 ${maxFiles} 个文件。`);
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await all<ChatAttachmentRow>(
    `SELECT * FROM chat_attachments
     WHERE conversation_id = ? AND id IN (${placeholders}) AND parse_status = 'ready'`,
    [id, ...uniqueIds]
  );
  if (rows.length !== uniqueIds.length) throw new Error('部分附件不存在、尚未解析完成或不属于当前会话。');
  await run(
    `UPDATE chat_attachments
     SET message_id = COALESCE(message_id, ?), updated_at = CURRENT_TIMESTAMP
     WHERE conversation_id = ? AND id IN (${placeholders})`,
    [messageId, id, ...uniqueIds]
  );
  await withTransaction(async (database) => {
    const binding = database.prepare(
      `INSERT INTO chat_message_attachments
       (conversation_id, message_id, attachment_id)
       VALUES (?, ?, ?)
       ON CONFLICT (message_id, attachment_id) DO NOTHING`
    );
    for (const attachmentId of uniqueIds) {
      await binding.run(id, messageId, attachmentId);
    }
  });
  return listChatAttachments(id, messageId);
}

export type DeleteChatAttachmentResult = 'deleted' | 'missing' | 'queued';

function queueReferencesAttachment(value: string, attachmentId: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.some((item) => String(item || '').trim() === attachmentId);
  } catch {
    return false;
  }
}

export async function deleteChatAttachmentIfUnqueued(
  conversationId: string,
  attachmentId: string
): Promise<DeleteChatAttachmentResult> {
  const id = safeConversationId(conversationId);
  const result = await withTransaction(async (database) => {
    await lockConversationQueueMutation(database, id);
    const queuedRows = await database.prepare(
      `SELECT attachment_ids_json
       FROM chat_send_queue
       WHERE conversation_id = ?`
    ).all<{ attachment_ids_json: string }>(id);
    if (queuedRows.some((row) => queueReferencesAttachment(row.attachment_ids_json, attachmentId))) {
      return { status: 'queued' as const, row: null };
    }

    const row = await database.prepare(
      `SELECT *
       FROM chat_attachments
       WHERE id = ? AND conversation_id = ?
       FOR UPDATE`
    ).get<ChatAttachmentRow>(attachmentId, id);
    if (!row) return { status: 'missing' as const, row: null };
    await database.prepare('DELETE FROM chat_message_attachments WHERE attachment_id = ? AND conversation_id = ?').run(attachmentId, id);
    await database.prepare('DELETE FROM chat_attachment_chunks WHERE attachment_id = ? AND conversation_id = ?').run(attachmentId, id);
    await database.prepare('DELETE FROM chat_attachments WHERE id = ? AND conversation_id = ?').run(attachmentId, id);
    return { status: 'deleted' as const, row };
  });
  if (result.status === 'deleted' && result.row) {
    await fs.rm(resolveInsideAttachmentRoot(id, result.row.stored_name), { force: true }).catch(() => undefined);
  }
  return result.status;
}

export async function deleteChatAttachment(conversationId: string, attachmentId: string) {
  return (await deleteChatAttachmentIfUnqueued(conversationId, attachmentId)) === 'deleted';
}

export async function deleteConversationAttachments(conversationId: string) {
  const id = safeConversationId(conversationId);
  await withTransaction(async (database) => {
    await database.prepare('DELETE FROM chat_message_attachments WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM chat_attachment_chunks WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM chat_attachments WHERE conversation_id = ?').run(id);
  });
  await fs.rm(resolveInsideAttachmentRoot(id), { recursive: true, force: true }).catch(() => undefined);
}

function ftsQuery(query: string) {
  return attachmentQueryTerms(query)
    .map((part) => part.trim())
    .slice(0, 12)
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function attachmentQueryTerms(query: string) {
  const normalized = query
    .replace(/["'()[\]{}:*^~\\/，。！？、；：,.!?;:-]+/g, ' ')
    .replace(/请问|麻烦|请|这(?:份|个|些)?|上述|上传(?:的)?|附件|文件|文档|表格|里面|其中|有哪些|是什么|怎么样|如何|是否|帮我|一下/g, ' ')
    .replace(/\s*的\s*/g, ' ')
    .trim();
  const segments = normalized.split(/\s+/).filter(Boolean);
  const terms = new Set<string>();
  for (const segment of segments) {
    if (segment.length >= 2) terms.add(segment.slice(0, 40));
    if (/^[\u3400-\u9fff]{4,}$/.test(segment)) {
      for (let index = 0; index < Math.min(segment.length - 1, 10); index += 2) {
        terms.add(segment.slice(index, index + 2));
      }
    }
  }
  return [...terms].slice(0, 12);
}

export async function searchChatAttachments(conversationId: string, query: string, limit = 8) {
  const id = safeConversationId(conversationId);
  const cappedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const match = ftsQuery(query);
  if (!match) return [] as AttachmentSearchResult[];
  if (await hasAttachmentFts()) {
    try {
      const ftsResults = (await all<{
        id: string;
        attachment_id: string;
        original_name: string;
        section: string;
        text: string;
        rank: number;
      }>(
        `SELECT c.id, c.attachment_id, a.original_name, c.section, c.text,
                ts_rank(c.search_tsv, to_tsquery('simple', ?)) AS rank
         FROM chat_attachment_chunks c
         JOIN chat_attachments a ON a.id = c.attachment_id AND a.conversation_id = c.conversation_id
         WHERE c.conversation_id = ? AND c.chunk_role = 'child'
           AND c.search_tsv @@ to_tsquery('simple', ?)
         ORDER BY rank DESC
         LIMIT ?`,
        [match.replace(/ OR /g, ' | ').replace(/"/g, ''), id, match.replace(/ OR /g, ' | ').replace(/"/g, ''), cappedLimit]
      )).map((row) => ({
        chunkId: row.id,
        attachmentId: row.attachment_id,
        fileName: row.original_name,
        section: row.section || '',
        text: row.text,
        score: Number(row.rank || 0)
      }));
      if (ftsResults.length) return ftsResults;
    } catch {
      // Fall through to a parameterized LIKE search when FTS is unavailable.
    }
  }
  const terms = attachmentQueryTerms(query);
  if (!terms.length) return [];
  const predicates = terms.map(() => '(c.text LIKE ? OR a.original_name LIKE ?)').join(' OR ');
  const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
  const likeRows = await all<{
    id: string;
    attachment_id: string;
    original_name: string;
    section: string;
    text: string;
  }>(
    `SELECT c.id, c.attachment_id, a.original_name, c.section, c.text
     FROM chat_attachment_chunks c
     JOIN chat_attachments a ON a.id = c.attachment_id AND a.conversation_id = c.conversation_id
     WHERE c.conversation_id = ? AND c.chunk_role = 'child'
       AND (${predicates})
     LIMIT ?`,
    [id, ...params, cappedLimit]
  );
  return likeRows.map((row) => ({
    chunkId: row.id,
    attachmentId: row.attachment_id,
    fileName: row.original_name,
    section: row.section || '',
    text: row.text,
    score: 0.5
  }));
}

export async function readChatAttachmentChunks(
  conversationId: string,
  attachmentIds: string[],
  maxFiles = ATTACHMENT_MAX_BIND_FILES
) {
  const id = safeConversationId(conversationId);
  const uniqueIds = [...new Set(attachmentIds)].slice(0, Math.max(1, Math.min(ATTACHMENT_MAX_BIND_FILES, maxFiles)));
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  return await all<{
    attachment_id: string;
    original_name: string;
    id: string;
    section: string;
    text: string;
    chunk_index: number;
  }>(
    `WITH ranked AS (
       SELECT c.attachment_id, c.id, c.section, c.text, c.chunk_index,
              ROW_NUMBER() OVER (PARTITION BY c.attachment_id ORDER BY c.chunk_index) AS row_number
       FROM chat_attachment_chunks c
       WHERE c.conversation_id = ? AND c.attachment_id IN (${placeholders}) AND c.chunk_role = 'parent'
     )
     SELECT ranked.attachment_id, a.original_name, ranked.id, ranked.section, ranked.text, ranked.chunk_index
     FROM ranked
     JOIN chat_attachments a ON a.id = ranked.attachment_id AND a.conversation_id = ?
     WHERE ranked.row_number <= 8
     ORDER BY a.created_at, ranked.chunk_index`,
    [id, ...uniqueIds, id]
  );
}

export function getAttachmentAbsolutePath(row: ChatAttachmentRow) {
  const expected = resolveInsideAttachmentRoot(row.conversation_id, row.stored_name);
  if (path.resolve(row.storage_path) !== expected) throw new Error('附件存储路径无效。');
  return expected;
}

export async function attachmentFtsAvailable() {
  return hasAttachmentFts();
}
