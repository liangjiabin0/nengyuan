import path from 'node:path';
import { ATTACHMENT_IMAGE_EXTENSION_SET } from './policy';

/**
 * Formats the agent cannot reliably `read` as UTF-8, so it should use
 * Microsoft MarkItDown (or another mature converter named by that skill).
 * ZIP is stored as-is; csv/html/tsv are UTF-8 text.
 */
export const ARCHIVE_EXTENSIONS = new Set(['.zip']);
export const DOCUMENT_READER_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
  '.epub',
  '.msg',
  '.eml',
  '.ipynb'
]);

export function attachmentNeedsDocumentReader(input: {
  extension?: string | null;
  original_name?: string | null;
  originalName?: string | null;
}) {
  const ext = String(
    input.extension || path.extname(input.original_name || input.originalName || '')
  ).toLowerCase();
  if (!ext || ATTACHMENT_IMAGE_EXTENSION_SET.has(ext)) return false;
  return DOCUMENT_READER_EXTENSIONS.has(ext);
}

export function attachmentIsArchive(input: {
  extension?: string | null;
  original_name?: string | null;
  originalName?: string | null;
}) {
  const ext = String(
    input.extension || path.extname(input.original_name || input.originalName || '')
  ).toLowerCase();
  return ARCHIVE_EXTENSIONS.has(ext);
}

/** Offer MarkItDown when the agent may need to convert documents or inspect a zip. */
export function shouldOfferDocumentReader(rows: Array<{
  extension?: string | null;
  original_name?: string | null;
  originalName?: string | null;
}>) {
  return rows.some((row) => attachmentNeedsDocumentReader(row) || attachmentIsArchive(row));
}
