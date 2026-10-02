import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const SIDECAR_STATE_PATH = path.join(process.cwd(), 'storage', 'opencode-sidecar.json');

function bearerToken(request: Request) {
  const header = String(request.headers.get('authorization') || '').trim();
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

function safeEqual(left: string, right: string) {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sidecarAgentToken() {
  try {
    const raw = fs.readFileSync(SIDECAR_STATE_PATH, 'utf8').replace(/^\uFEFF/, '');
    const state = JSON.parse(raw) as { agentApiToken?: unknown };
    return typeof state.agentApiToken === 'string' ? state.agentApiToken.trim() : '';
  } catch {
    return '';
  }
}

/** Authenticate the local OpenCode tool without relying on Host or network headers. */
export function isAgentServiceRequest(request: Request) {
  const provided = bearerToken(request);
  if (!provided) return false;
  const configured = String(process.env.AI4ES_AGENT_API_TOKEN || '').trim();
  return safeEqual(provided, configured) || safeEqual(provided, sidecarAgentToken());
}
