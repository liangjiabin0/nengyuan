import { abortConversationRun, isConversationRunActive } from '@/lib/chat-run-registry';
import { abortOpenCodeConversation } from '@/lib/opencode/runtime';
import { RESEARCH_REVIEW_SESSION_MAP } from '@/lib/research-review/constants';

export async function stopConversationGeneration(conversationId: string, userId: string) {
  const matched = await abortConversationRun(conversationId, userId);
  if (!matched) return;
  await Promise.allSettled([
    abortOpenCodeConversation(conversationId),
    abortOpenCodeConversation(conversationId, { sessionMapFile: RESEARCH_REVIEW_SESSION_MAP })
  ]);
}

/** Stop the live run and wait until its persister has finished writing. */
export async function stopConversationGenerationAndSettle(
  conversationId: string,
  userId: string,
  timeoutMs = 4_000
) {
  await stopConversationGeneration(conversationId, userId);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (await isConversationRunActive(conversationId, userId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return !(await isConversationRunActive(conversationId, userId));
}
