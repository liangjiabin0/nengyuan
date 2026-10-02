import type { ChatAttachment } from '@/lib/chat-attachments';

export type ChatQueuedTurn = {
  id: string;
  conversationId: string;
  question: string;
  attachments: ChatAttachment[];
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
};

async function readJson(response: Response) {
  return response.json().catch(() => ({})) as Promise<{
    error?: string;
    items?: ChatQueuedTurn[];
    item?: ChatQueuedTurn;
  }>;
}

export async function fetchSendQueue() {
  const response = await fetch('/api/chat/queue');
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || '加载排队失败。');
  return Array.isArray(data.items) ? data.items : [];
}

export async function createSendQueueItem(input: {
  id?: string;
  conversationId: string;
  question: string;
  attachmentIds: string[];
}) {
  const id = input.id || crypto.randomUUID();
  const response = await fetch('/api/chat/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, id })
  });
  const data = await readJson(response);
  if (!response.ok || !data.item) throw new Error(data.error || '加入排队失败。');
  return data.item;
}

export async function deleteSendQueueItem(id: string) {
  const response = await fetch(`/api/chat/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await readJson(response);
  if (response.status === 404) return data.item || null;
  if (!response.ok) throw new Error(data.error || '移除排队失败。');
  return data.item || null;
}

export async function peekNextSendQueueItem(conversationId: string) {
  const response = await fetch('/api/chat/queue/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId })
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || '取出排队失败。');
  return data.item || null;
}
