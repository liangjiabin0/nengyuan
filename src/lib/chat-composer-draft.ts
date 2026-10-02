import type { ComposerToolId } from './chat-composer-tools';

const DB_NAME = 'ai4es-composer-draft';
const STORE_NAME = 'drafts';
const DB_VERSION = 1;

export type ComposerDraftAttachment = {
  id: string;
  conversationId: string;
  name: string;
  extension: string;
  mediaType: string;
  size: number;
  status: string;
  previewUrl: string;
  downloadUrl?: string;
  createdAt?: string;
  deduplicated?: boolean;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type ComposerDraftFile = {
  clientId: string;
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
  attachment?: ComposerDraftAttachment;
  attachments?: ComposerDraftAttachment[];
};

export type ComposerDraft = {
  question: string;
  composerTool: ComposerToolId | null;
  files: ComposerDraftFile[];
};

const memoryDrafts = new Map<string, ComposerDraft>();

function keySegment(value: string | null | undefined, fallback: string) {
  return encodeURIComponent(String(value || '').trim() || fallback);
}

export function composerDraftKey(scope: string, userId: string | null | undefined) {
  return `${keySegment(scope, 'chat')}:user:${keySegment(userId, 'anonymous')}:composer`;
}

export function isComposerDraftEmpty(draft: Pick<ComposerDraft, 'question' | 'composerTool' | 'files'>) {
  return !draft.question.trim() && !draft.composerTool && !draft.files.length;
}

export function readComposerDraftMemory(key: string) {
  return memoryDrafts.get(key) || null;
}

export function writeComposerDraftMemory(key: string, draft: ComposerDraft | null) {
  if (!draft || isComposerDraftEmpty(draft)) {
    memoryDrafts.delete(key);
    return;
  }
  memoryDrafts.set(key, draft);
}

function canUseIndexedDb() {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开输入缓存失败'));
  });
}

async function idbGet(key: string): Promise<ComposerDraft | null> {
  if (!canUseIndexedDb()) return null;
  try {
    const db = await openDraftDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as ComposerDraft | undefined) || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, draft: ComposerDraft | null) {
  if (!canUseIndexedDb()) return;
  try {
    const db = await openDraftDb();
    await new Promise<void>((resolve, reject) => {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      const request = draft && !isComposerDraftEmpty(draft) ? store.put(draft, key) : store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // private mode / quota
  }
}

export function writeComposerDraft(key: string, draft: ComposerDraft | null) {
  writeComposerDraftMemory(key, draft);
  void idbSet(key, draft && !isComposerDraftEmpty(draft) ? draft : null);
}

export async function readComposerDraft(key: string): Promise<ComposerDraft | null> {
  const memory = readComposerDraftMemory(key);
  if (memory) return memory;
  const stored = await idbGet(key);
  if (stored) writeComposerDraftMemory(key, stored);
  return stored;
}

export function clearComposerDraft(key: string) {
  writeComposerDraft(key, null);
}

export function fileFromDraftBlob(file: ComposerDraftFile) {
  if (file.blob instanceof File && file.blob.name === file.name) return file.blob;
  return new File([file.blob], file.name, {
    type: file.type || file.blob.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now()
  });
}
