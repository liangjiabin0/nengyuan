import { randomUUID } from 'node:crypto';
import { all, get, run } from '../db';
import { hashPassword, verifyPassword } from './password';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  type AuthUser,
  type UserRole
} from './types';

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
};

let defaultAdminCache: AuthUser | null = null;

function mapUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getUserById(id: string) {
  const row = await get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  return row ? mapUser(row) : null;
}

export async function getUserByUsername(username: string) {
  const row = await get<UserRow>('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username.trim()]);
  return row ? mapUser(row) : null;
}

export async function getUserRowByUsername(username: string) {
  return get<UserRow>('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username.trim()]);
}

export async function listUsers() {
  const rows = await all<UserRow>('SELECT * FROM users ORDER BY role DESC, username ASC');
  return rows.map(mapUser);
}

export async function ensureDefaultAdmin() {
  if (defaultAdminCache) return defaultAdminCache;
  const existing = await getUserByUsername(DEFAULT_ADMIN_USERNAME);
  if (existing) {
    defaultAdminCache = existing;
    return existing;
  }
  if (DEFAULT_ADMIN_PASSWORD.length < 12) {
    throw new Error('首次创建管理员必须设置至少12位的 DEFAULT_ADMIN_PASSWORD。');
  }
  const id = randomUUID();
  await run(
    `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, DEFAULT_ADMIN_USERNAME, hashPassword(DEFAULT_ADMIN_PASSWORD)]
  );
  const created = await getUserById(id);
  if (!created) throw new Error('默认管理员创建失败。');
  defaultAdminCache = created;
  return created;
}

export async function authenticateUser(username: string, password: string) {
  const row = await getUserRowByUsername(username);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return mapUser(row);
}

export async function createUser(input: { username: string; password: string; role?: UserRole }) {
  const username = String(input.username || '').trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff-]{2,32}$/.test(username)) {
    throw new Error('用户名需为 2–32 位字母、数字、下划线、连字符或中文。');
  }
  if (String(input.password || '').length < 4) {
    throw new Error('密码至少 4 位。');
  }
  if (await getUserByUsername(username)) {
    throw new Error('用户名已存在。');
  }
  const id = randomUUID();
  const role: UserRole = input.role === 'admin' ? 'admin' : 'user';
  await run(
    `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, username, hashPassword(input.password), role]
  );
  const created = await getUserById(id);
  if (!created) throw new Error('用户创建失败。');
  return created;
}

export async function updateUserPassword(userId: string, password: string) {
  if (String(password || '').length < 4) {
    throw new Error('密码至少 4 位。');
  }
  const user = await getUserById(userId);
  if (!user) throw new Error('用户不存在。');
  await run(
    'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [hashPassword(password), userId]
  );
  if (defaultAdminCache?.id === userId) defaultAdminCache = null;
  const updated = await getUserById(userId);
  if (!updated) throw new Error('用户不存在。');
  return updated;
}

export async function countAdmins() {
  const row = await get<{ count: number }>('SELECT COUNT(*) AS count FROM users WHERE role = ?', ['admin']);
  return Number(row?.count || 0);
}

export async function updateUserRole(userId: string, role: UserRole) {
  const nextRole: UserRole = role === 'admin' ? 'admin' : 'user';
  const user = await getUserById(userId);
  if (!user) throw new Error('用户不存在。');
  if (user.role === nextRole) return user;
  if (user.role === 'admin' && nextRole === 'user' && (await countAdmins()) <= 1) {
    throw new Error('系统至少保留一名管理员。');
  }
  await run(
    'UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [nextRole, userId]
  );
  if (defaultAdminCache?.id === userId) defaultAdminCache = null;
  const updated = await getUserById(userId);
  if (!updated) throw new Error('用户不存在。');
  return updated;
}

export async function deleteUser(userId: string, options?: { actorId?: string }) {
  const user = await getUserById(userId);
  if (!user) throw new Error('用户不存在。');
  if (options?.actorId && options.actorId === userId) {
    throw new Error('不能删除当前登录账号。');
  }
  if (user.role === 'admin' && (await countAdmins()) <= 1) {
    throw new Error('系统至少保留一名管理员。');
  }
  await run('DELETE FROM users WHERE id = ?', [userId]);
  if (defaultAdminCache?.id === userId) defaultAdminCache = null;
  return user;
}

export async function deleteUsers(userIds: string[], options?: { actorId?: string }) {
  const ids = Array.from(new Set(userIds.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) throw new Error('请选择要删除的账号。');
  const deleted: AuthUser[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      deleted.push(await deleteUser(id, options));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '删除失败');
    }
  }
  if (!deleted.length) {
    throw new Error(errors[0] || '删除失败。');
  }
  return { deleted, errors };
}

export async function updateUsersRole(userIds: string[], role: UserRole, options?: { actorId?: string }) {
  const ids = Array.from(new Set(userIds.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) throw new Error('请选择要更新的账号。');
  const nextRole: UserRole = role === 'admin' ? 'admin' : 'user';

  if (nextRole === 'user') {
    const demotingAdminIds: string[] = [];
    for (const id of ids) {
      if (options?.actorId && options.actorId === id) continue;
      if ((await getUserById(id))?.role === 'admin') demotingAdminIds.push(id);
    }
    if (demotingAdminIds.length > 0 && demotingAdminIds.length >= (await countAdmins())) {
      throw new Error('系统至少保留一名管理员。');
    }
  }

  const updated: AuthUser[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      if (options?.actorId && options.actorId === id && nextRole === 'user') {
        throw new Error('不能将当前登录账号降为普通用户。');
      }
      updated.push(await updateUserRole(id, nextRole));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '更新角色失败');
    }
  }
  if (!updated.length) {
    throw new Error(errors[0] || '更新角色失败。');
  }
  return { updated, errors };
}

export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
  const row = await get<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row) throw new Error('用户不存在。');
  if (!verifyPassword(currentPassword, row.password_hash)) {
    throw new Error('当前密码不正确。');
  }
  if (String(newPassword || '').length < 4) {
    throw new Error('新密码至少 4 位。');
  }
  if (currentPassword === newPassword) {
    throw new Error('新密码不能与当前密码相同。');
  }
  return updateUserPassword(userId, newPassword);
}

export function isAdminUser(user: AuthUser | null | undefined) {
  return user?.role === 'admin';
}
