type TimeoutCapableServer = {
  timeout?: number;
  headersTimeout?: number;
  requestTimeout?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

/** Long OpenCode tool rounds must not be killed by Node HTTP idle/request timeouts. */
export function disableHttpServerTimeouts(server: unknown) {
  if (!isRecord(server)) return;
  const target = server as TimeoutCapableServer;
  if ('timeout' in server) target.timeout = 0;
  if ('requestTimeout' in server) target.requestTimeout = 0;
  if ('headersTimeout' in server) target.headersTimeout = 0;
}
