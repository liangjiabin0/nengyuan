'use client';

import { FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Plus, Search, Trash2, X } from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useNotifyError, useNotifySuccess } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { UiSelect } from '@/components/ui-select';
import type { AuthUserPublic, UserRole } from '@/lib/auth/types';
import { cn } from '@/lib/utils';

type UsersResponse = { users?: AuthUserPublic[]; error?: string };
type ModalKind = 'create' | 'edit' | 'batch-role' | 'batch-delete' | null;

const ROLE_OPTIONS = [
  { value: 'user' as const, label: '普通用户' },
  { value: 'admin' as const, label: '管理员' }
];

function formatDate(value: string) {
  if (!value) return '—';
  return value.slice(0, 16).replace('T', ' ');
}

function roleLabel(role: UserRole) {
  return role === 'admin' ? '管理员' : '普通用户';
}

function ModalShell({
  title,
  description,
  onClose,
  children,
  dismissible = true,
  footer
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  dismissible?: boolean;
  footer?: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && dismissible) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismissible, onClose]);

  return (
    <div
      className="rag-evidence-modal-backdrop"
      onClick={() => {
        if (dismissible) onClose();
      }}
    >
      <div
        className="rag-evidence-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!dismissible}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="px-4 py-3">
          {children}
        </div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function AdminUsersPanel() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AuthUserPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setError] = useNotifyError();
  const [, setMessage] = useNotifySuccess();
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<ModalKind>(null);
  const [targetUser, setTargetUser] = useState<AuthUserPublic | null>(null);
  const [busy, setBusy] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [editRole, setEditRole] = useState<UserRole>('user');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [batchRole, setBatchRole] = useState<UserRole>('user');

  usePageContentReady(!loading);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/admin/users')
      .then(async (response) => {
        const payload = (await response.json()) as UsersResponse;
        if (!response.ok) throw new Error(payload.error || '加载用户失败');
        if (!cancelled) setUsers(payload.users || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载用户失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((user) => (
      user.username.toLowerCase().includes(q)
      || roleLabel(user.role).includes(q)
      || user.role.includes(q)
    ));
  }, [users, query]);

  const allFilteredSelected =
    filteredUsers.length > 0 && filteredUsers.every((user) => selectedIds.has(user.id));
  const selectedUsers = useMemo(
    () => users.filter((user) => selectedIds.has(user.id)),
    [users, selectedIds]
  );

  function clearFeedback() {
    setError('');
    setMessage('');
  }

  function resetModalState() {
    setModal(null);
    setTargetUser(null);
    setUsername('');
    setPassword('');
    setRole('user');
    setEditRole('user');
    setNewPassword('');
    setConfirmPassword('');
    setBatchRole('user');
  }

  function closeModal() {
    if (busy) return;
    resetModalState();
  }

  function openCreate() {
    clearFeedback();
    setUsername('');
    setPassword('');
    setRole('user');
    setModal('create');
  }

  function openEdit(user: AuthUserPublic) {
    clearFeedback();
    setTargetUser(user);
    setEditRole(user.role);
    setNewPassword('');
    setConfirmPassword('');
    setModal('edit');
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const user of filteredUsers) next.delete(user.id);
      } else {
        for (const user of filteredUsers) next.add(user.id);
      }
      return next;
    });
  }

  async function refreshQuiet() {
    const response = await fetch('/api/admin/users');
    const payload = (await response.json()) as UsersResponse;
    if (!response.ok) throw new Error(payload.error || '加载用户失败');
    const nextUsers = payload.users || [];
    setUsers(nextUsers);
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (nextUsers.some((user) => user.id === id)) next.add(id);
      }
      return next;
    });
    return nextUsers;
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    clearFeedback();
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '创建失败');
      setMessage(`已创建「${payload.user?.username || username}」`);
      resetModalState();
      await refreshQuiet();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function onSaveEdit(event: FormEvent) {
    event.preventDefault();
    if (!targetUser) return;

    const wantsPassword = Boolean(newPassword || confirmPassword);
    if (wantsPassword) {
      if (newPassword.length < 4) {
        clearFeedback();
        setError('新密码至少 4 位。');
        return;
      }
      if (newPassword !== confirmPassword) {
        clearFeedback();
        setError('两次输入的新密码不一致。');
        return;
      }
    }

    const roleChanged = editRole !== targetUser.role;
    if (!wantsPassword && !roleChanged) {
      resetModalState();
      return;
    }

    setBusy(true);
    clearFeedback();
    try {
      if (roleChanged) {
        const response = await fetch('/api/admin/users', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [targetUser.id], role: editRole })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || '更新角色失败');
      }
      if (wantsPassword) {
        const response = await fetch(`/api/admin/users/${targetUser.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPassword })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || '修改密码失败');
      }
      const parts = [
        roleChanged ? '角色已更新' : '',
        wantsPassword ? '密码已重置' : ''
      ].filter(Boolean);
      setMessage(`${parts.join('，')}。`);
      resetModalState();
      await refreshQuiet();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteOne() {
    if (!targetUser) return;
    setBusy(true);
    clearFeedback();
    try {
      const response = await fetch(`/api/admin/users/${targetUser.id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '删除失败');
      setMessage(payload.message || `已删除「${targetUser.username}」`);
      resetModalState();
      await refreshQuiet();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  async function onBatchRole(event: FormEvent) {
    event.preventDefault();
    const ids = Array.from(selectedIds);
    if (!ids.length) {
      setError('请选择要更新的账号。');
      return;
    }
    setBusy(true);
    clearFeedback();
    try {
      const response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, role: batchRole })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '更新角色失败');
      const warning = Array.isArray(payload.warnings) && payload.warnings.length
        ? `（部分跳过：${payload.warnings[0]}）`
        : '';
      setMessage(`${payload.message || '角色已更新'}${warning}`);
      setSelectedIds(new Set());
      resetModalState();
      await refreshQuiet();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新角色失败');
    } finally {
      setBusy(false);
    }
  }

  async function onBatchDelete() {
    const ids = Array.from(selectedIds);
    if (!ids.length) {
      setError('请选择要删除的账号。');
      return;
    }
    setBusy(true);
    clearFeedback();
    try {
      const response = await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '删除失败');
      const warning = Array.isArray(payload.warnings) && payload.warnings.length
        ? `（部分跳过：${payload.warnings[0]}）`
        : '';
      setMessage(`${payload.message || '已删除'}${warning}`);
      setSelectedIds(new Set());
      resetModalState();
      await refreshQuiet();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  const isSelf = Boolean(targetUser && currentUser?.id === targetUser.id);

  return (
    <div className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Admin / Users
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">账号管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          用于管理系统账号、用户角色和登录密码。
        </p>
      </div>

      <div className="rag-chat-card min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索用户名或角色"
              className="ui-input h-8 pl-8 text-xs"
            />
          </div>

          {selectedIds.size > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">已选 {selectedIds.size}</span>
              <button
                type="button"
                className="ui-btn-secondary h-8 px-2.5 text-xs"
                onClick={() => {
                  clearFeedback();
                  setBatchRole('user');
                  setModal('batch-role');
                }}
              >
                改角色
              </button>
              <button
                type="button"
                className="ui-btn-secondary h-8 px-2.5 text-xs text-rose-700 hover:bg-rose-50"
                onClick={() => {
                  clearFeedback();
                  setModal('batch-delete');
                }}
              >
                删除
              </button>
              <button
                type="button"
                className="ui-btn-ghost h-8 px-2 text-xs"
                onClick={() => setSelectedIds(new Set())}
              >
                取消
              </button>
            </div>
          ) : (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              共 {filteredUsers.length} 人 · 单击行编辑
            </span>
          )}

          <button type="button" className="ui-btn-primary h-8 gap-1 px-2.5 text-xs" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            添加
          </button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 border-b border-border bg-muted/60">
              <tr className="text-left text-[11px] font-medium text-muted-foreground">
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-border"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAllFiltered}
                    disabled={!filteredUsers.length}
                    aria-label="全选"
                  />
                </th>
                <th className="px-2 py-2 font-medium">用户名</th>
                <th className="w-24 px-2 py-2 font-medium">角色</th>
                <th className="hidden w-40 px-2 py-2 font-medium sm:table-cell">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-3 py-12 text-center text-xs text-muted-foreground">
                    加载中…
                  </td>
                </tr>
              ) : filteredUsers.length ? (
                filteredUsers.map((user) => {
                  const selected = selectedIds.has(user.id);
                  const self = currentUser?.id === user.id;
                  return (
                    <tr
                      key={user.id}
                      className={cn(
                        'cursor-pointer border-b border-border/70 transition last:border-b-0 hover:bg-muted/50',
                        selected && 'bg-muted/40'
                      )}
                      onClick={() => openEdit(user)}
                    >
                      <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-border"
                          checked={selected}
                          onChange={() => toggleSelect(user.id)}
                          aria-label={`选择 ${user.username}`}
                        />
                      </td>
                      <td className="max-w-[14rem] truncate px-2 py-1.5">
                        <span className="text-[13px] font-medium text-foreground">{user.username}</span>
                        {self ? (
                          <span className="ml-1.5 text-[10px] text-muted-foreground">当前</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className={cn(
                            'inline-flex rounded px-1.5 py-0.5 text-[11px]',
                            user.role === 'admin'
                              ? 'bg-foreground text-background'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {roleLabel(user.role)}
                        </span>
                      </td>
                      <td className="hidden px-2 py-1.5 text-xs text-muted-foreground sm:table-cell">
                        {formatDate(user.createdAt)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={4} className="px-3 py-12 text-center text-xs text-muted-foreground">
                    {query.trim() ? '没有匹配的账号' : '暂无账号，点击右上角添加'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modal === 'create' ? (
        <ModalShell
          title="添加账号"
          description="创建后可立即登录。"
          onClose={closeModal}
          dismissible={!busy}
          footer={(
            <>
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button type="submit" form="create-user-form" className="ui-btn-primary h-8 px-3 text-xs" disabled={busy}>
                {busy ? '创建中…' : '创建'}
              </button>
            </>
          )}
        >
          <form id="create-user-form" className="space-y-3" onSubmit={onCreate}>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">用户名</span>
              <input
                className="ui-input h-8 text-sm"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="2–32 位"
                required
                autoFocus
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">初始密码</span>
              <input
                className="ui-input h-8 text-sm"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 4 位"
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">角色</span>
              <UiSelect
                value={role}
                options={ROLE_OPTIONS}
                onChange={setRole}
                aria-label="角色"
              />
            </label>
          </form>
        </ModalShell>
      ) : null}

      {modal === 'edit' && targetUser ? (
        <ModalShell
          title="编辑账号"
          description={`${targetUser.username} · 创建于 ${formatDate(targetUser.createdAt)}`}
          onClose={closeModal}
          dismissible={!busy}
          footer={(
            <>
              <button
                type="button"
                className="mr-auto inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs text-rose-600 transition hover:bg-rose-50 disabled:opacity-40"
                onClick={() => void onDeleteOne()}
                disabled={busy || isSelf}
                title={isSelf ? '不能删除当前登录账号' : '删除账号'}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </button>
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button type="submit" form="edit-user-form" className="ui-btn-primary h-8 px-3 text-xs" disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
            </>
          )}
        >
          <form id="edit-user-form" className="space-y-3" onSubmit={onSaveEdit}>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">角色</span>
              <UiSelect
                value={editRole}
                options={ROLE_OPTIONS}
                onChange={setEditRole}
                disabled={isSelf}
                aria-label="角色"
              />
            </label>
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-[11px] font-medium text-muted-foreground">重置密码（可选）</div>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted-foreground">新密码</span>
                <input
                  className="ui-input h-8 bg-background text-sm"
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="留空则不修改"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted-foreground">确认新密码</span>
                <input
                  className="ui-input h-8 bg-background text-sm"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="再次输入"
                />
              </label>
            </div>
          </form>
        </ModalShell>
      ) : null}

      {modal === 'batch-role' ? (
        <ModalShell
          title="批量修改角色"
          description={`已选 ${selectedUsers.length} 个账号`}
          onClose={closeModal}
          dismissible={!busy}
          footer={(
            <>
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button type="submit" form="batch-role-form" className="ui-btn-primary h-8 px-3 text-xs" disabled={busy}>
                {busy ? '更新中…' : '确认'}
              </button>
            </>
          )}
        >
          <form id="batch-role-form" className="space-y-3" onSubmit={onBatchRole}>
            <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
              {selectedUsers.slice(0, 8).map((user) => user.username).join('、')}
              {selectedUsers.length > 8 ? ` 等 ${selectedUsers.length} 人` : ''}
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">目标角色</span>
              <UiSelect
                value={batchRole}
                options={ROLE_OPTIONS}
                onChange={setBatchRole}
                aria-label="目标角色"
              />
            </label>
          </form>
        </ModalShell>
      ) : null}

      {modal === 'batch-delete' ? (
        <ModalShell
          title="批量删除账号"
          description="删除后无法恢复。"
          onClose={closeModal}
          dismissible={!busy}
          footer={(
            <>
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-md bg-rose-600 px-3 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                onClick={() => void onBatchDelete()}
                disabled={busy || !selectedUsers.length}
              >
                {busy ? '删除中…' : '确认删除'}
              </button>
            </>
          )}
        >
          <div className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-700">
            {selectedUsers.slice(0, 10).map((user) => user.username).join('、')}
            {selectedUsers.length > 10 ? ` 等 ${selectedUsers.length} 个账号` : ''}
          </div>
        </ModalShell>
      ) : null}
    </div>
  );
}
