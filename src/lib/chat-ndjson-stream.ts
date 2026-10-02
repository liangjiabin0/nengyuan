/** Heartbeats keep the Next.js rewrite proxy socket active during long tool rounds. */
export const CHAT_STREAM_HEARTBEAT_MS = 4_000;

export const CHAT_NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no'
} as const;
