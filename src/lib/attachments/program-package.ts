import path from 'node:path';
import { attachmentNeedsDocumentReader } from './document-reader';

export const PROGRAM_BINARY_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pdb',
  '.lib',
  '.sys',
  '.com'
]);

/** Inner files worth keeping when a zip is a solver/build package rather than literature. */
export const PROGRAM_PACKAGE_KEEP_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.rtf',
  '.odt',
  '.md',
  '.markdown',
  '.txt'
]);

export type AgentAttachmentKind = 'document' | 'inventory' | 'program' | 'binary' | 'text' | 'archive';

export const PROGRAM_PACKAGE_INVENTORY_NOTICE = [
  '这是带可执行文件的程序/算例包。',
  '若已加载对应求解技能（例如 ses-iesp-esopt），用技能写明的本机安装路径直接求解；',
  '不要对附件 exe 做哈希比对，不要把压缩包当第二套运行环境，也不必通读本清单。'
].join('');

export function zipLooksLikeProgramPackage(relativePaths: string[]) {
  return relativePaths.some((relativePath) => (
    PROGRAM_BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
  ));
}

export function shouldExtractZipEntry(relativePath: string, programPackage: boolean) {
  const extension = path.extname(relativePath).toLowerCase();
  if (PROGRAM_BINARY_EXTENSIONS.has(extension)) return false;
  if (!programPackage) return true;
  return PROGRAM_PACKAGE_KEEP_EXTENSIONS.has(extension);
}

export function isZipInventoryName(name: string) {
  return /清单\.(?:orig\.)?md$/i.test(path.basename(name));
}

export function classifyAttachmentKind(input: {
  name: string;
  extension?: string | null;
  metadata?: Record<string, unknown> | null;
}): AgentAttachmentKind {
  const name = String(input.name || '');
  const extension = String(input.extension || path.extname(name) || '').toLowerCase();
  const role = String(input.metadata?.role || '').toLowerCase();
  if (role === 'zip-inventory' || isZipInventoryName(name)) return 'inventory';
  if (role === 'program-package' || PROGRAM_BINARY_EXTENSIONS.has(extension)) return 'program';
  if (/openTEPES_esopt/i.test(name) || /ses_iesp_esopt/i.test(name)) return 'program';
  if (extension === '.zip') return 'archive';
  if (attachmentNeedsDocumentReader({ originalName: name, extension })) return 'document';
  if (extension === '.md' || extension === '.markdown' || extension === '.txt' || extension === '.csv') {
    return 'text';
  }
  return 'binary';
}
