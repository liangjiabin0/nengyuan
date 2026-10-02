export const OPENCODE_SESSION_HEADER = 'x-ai4es-session-id';

export const SessionHeaders = async () => ({
  'chat.headers': async (
    input: { sessionID?: string },
    output: { headers: Record<string, string> }
  ) => {
    const sessionId = String(input.sessionID || '').trim();
    if (!sessionId) return;
    output.headers[OPENCODE_SESSION_HEADER] = sessionId;
  }
});

export default SessionHeaders;
