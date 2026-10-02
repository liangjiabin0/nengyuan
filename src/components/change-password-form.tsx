'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useNotifyError, useNotifySuccess } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [, setError] = useNotifyError();
  const [, setMessage] = useNotifySuccess();
  const [loading, setLoading] = useState(false);
  usePageContentReady(true);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '修改密码失败');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setMessage(payload.message || '密码已更新。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改密码失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-lg flex-col gap-6 overflow-auto p-6">
      <div>
        <div className="ui-kicker">Account / Password</div>
        <h1 className="ui-page-title mt-1">修改密码</h1>
        <p className="mt-2 text-sm text-slate-500">用于修改当前账号的登录密码。</p>
      </div>

      <form className="ui-card space-y-4 p-5" onSubmit={onSubmit}>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-600">当前密码</span>
          <input
            className="ui-input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-600">新密码</span>
          <input
            className="ui-input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            minLength={4}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-600">确认新密码</span>
          <input
            className="ui-input"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            minLength={4}
          />
        </label>
        <div className="flex items-center gap-3 pt-1">
          <button type="submit" className="ui-btn-primary" disabled={loading}>
            {loading ? '保存中…' : '保存新密码'}
          </button>
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-800">
            返回
          </Link>
        </div>
      </form>
    </div>
  );
}
