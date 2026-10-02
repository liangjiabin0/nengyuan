import { randomBytes } from 'node:crypto';
import { get, run } from '../db';
import { getUserById } from './users';
import { SESSION_TTL_MS, type AuthUser } from './types';

type SessionRow = {
  token: string;
  user_id: string;
  expires_at: string;
  created_at: string;
};

function expiresAtIso(fromMs = Date.now()) {
  return new Date(fromMs + SESSION_TTL_MS).toISOString();
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex');
  await run(
    `INSERT INTO auth_sessions (token, user_id, expires_at, created_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    [token, userId, expiresAtIso()]
  );
  return token;
}

export async function deleteSession(token: string) {
  if (!token) return;
  await run('DELETE FROM auth_sessions WHERE token = ?', [token]);
}

export async function deleteSessionsForUser(userId: string) {
  await run('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);
}

export async function getSessionUser(token: string | undefined | null): Promise<AuthUser | null> {
  if (!token) return null;
  const row = await get<SessionRow>('SELECT * FROM auth_sessions WHERE token = ?', [token]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteSession(token);
    return null;
  }
  const user = await getUserById(row.user_id);
  if (!user) {
    await deleteSession(token);
    return null;
  }
  await run(
    'UPDATE auth_sessions SET expires_at = ? WHERE token = ?',
    [expiresAtIso(), token]
  );
  return user;
}

export async function purgeExpiredSessions() {
  await run("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')");
}
