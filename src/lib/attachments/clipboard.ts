import { ATTACHMENT_IMAGE_EXTENSION_SET } from './policy';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/x-ms-bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/xml': '.xml',
  'application/xml': '.xml',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
};

export function extensionFromMime(mime: string) {
  return MIME_TO_EXT[String(mime || '').split(';', 1)[0].trim().toLowerCase()] || '';
}

export function extensionFromImageMime(mime: string) {
  const ext = extensionFromMime(mime);
  return ATTACHMENT_IMAGE_EXTENSION_SET.has(ext) ? ext : '';
}

export function fileExtension(name: string) {
  const index = String(name || '').lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

export function isClipboardImageFile(file: File) {
  if (String(file.type || '').toLowerCase().startsWith('image/')) return true;
  return ATTACHMENT_IMAGE_EXTENSION_SET.has(fileExtension(file.name));
}

function pasteStamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function pasteFileName(prefix: string, ext: string) {
  return `${prefix}-${pasteStamp()}${ext}`;
}

/** Give clipboard blobs a real filename/extension so upload can accept them. */
export function normalizeClipboardFile(file: File): File {
  if (fileExtension(file.name)) return file;
  const mime = String(file.type || '').split(';', 1)[0].trim().toLowerCase();
  const ext = extensionFromMime(mime) || '.bin';
  const image = ext ? ATTACHMENT_IMAGE_EXTENSION_SET.has(ext) : mime.startsWith('image/');
  const name = file.name?.trim()
    ? `${file.name}${ext}`
    : pasteFileName(image ? '粘贴图片' : '粘贴文件', ext);
  return new File([file], name, {
    type: mime || (image ? 'image/png' : 'application/octet-stream'),
    lastModified: file.lastModified
  });
}

export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  const seen = new Set<string>();

  function pushFile(raw: File) {
    if (!raw.size) return;
    const file = normalizeClipboardFile(raw);
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  }

  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue;
    const raw = item.getAsFile();
    if (raw) pushFile(raw);
  }
  if (!files.length) {
    for (const raw of Array.from(data.files || [])) pushFile(raw);
  }
  return files;
}
