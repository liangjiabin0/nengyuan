/** Client-safe unified attachment policy shared by chat / review / guide / patent. */

export const ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;
export const ATTACHMENT_MAX_UPLOAD_FILES = 50;
export const ATTACHMENT_MAX_BIND_FILES = 500;

/** Image formats stored as binary attachments and sent as visual input. */
export const ATTACHMENT_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg'
] as const;

/** Formats that can be parsed into searchable text, plus images. */
export const ATTACHMENT_PARSE_EXTENSIONS = [
  '.pdf',
  '.docx',
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
  '.xlsx',
  '.xls',
  ...ATTACHMENT_IMAGE_EXTENSIONS
] as const;

/** Upload accept list includes ZIP; archives are stored as-is, not auto-extracted. */
export const ATTACHMENT_UPLOAD_EXTENSIONS = [
  ...ATTACHMENT_PARSE_EXTENSIONS,
  '.zip'
] as const;

export const ATTACHMENT_PARSE_EXTENSION_SET = new Set<string>(ATTACHMENT_PARSE_EXTENSIONS);
export const ATTACHMENT_UPLOAD_EXTENSION_SET = new Set<string>(ATTACHMENT_UPLOAD_EXTENSIONS);
export const ATTACHMENT_IMAGE_EXTENSION_SET = new Set<string>(ATTACHMENT_IMAGE_EXTENSIONS);

export const ATTACHMENT_ACCEPT = [...ATTACHMENT_UPLOAD_EXTENSIONS, 'image/*'].join(',');

export const ATTACHMENT_FORMAT_HINT =
  'PDF/DOCX/MD/TXT/表格/图片/JSON/ZIP 等 · 原样保存，由助手决定是否解压或解析 · 单文件最大 200MB · 一次最多 50 个';

/** 能元对话：不限制扩展名，由 agent 自行读取和解析。 */
export const CHAT_ATTACHMENT_HINT =
  '任意文件均可粘贴、拖入或选择 · 原样保存，由助手决定如何处理 · 单文件最大 200MB · 一次最多 50 个';

export const ATTACHMENT_MAX_BYTES_LABEL = '200 MB';
