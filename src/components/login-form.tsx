'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { Maximize2, X } from 'lucide-react';
import { loginAction } from '@/app/login/actions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

export function LoginForm() {
  const searchParams = useSearchParams();
  const nextPath = useMemo(() => {
    const value = searchParams.get('next') || '/';
    return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login') ? value : '/';
  }, [searchParams]);
  const error = searchParams.get('error') || '';
  const [demoAlive, setDemoAlive] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);

  useEffect(() => {
    if (error) notify.error(error);
  }, [error]);

  useEffect(() => {
    const host = window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    };
    const warm = () => setDemoAlive(true);
    if (host.requestIdleCallback) host.requestIdleCallback(warm, { timeout: 4000 });
    else window.setTimeout(warm, 1500);
  }, []);

  function openDemo() {
    setDemoAlive(true);
    setDemoOpen(true);
  }

  function closeDemo() {
    setDemoOpen(false);
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-background px-4">
      <button
        type="button"
        className="ui-btn-ghost absolute bottom-6 left-6 z-50 min-h-11 touch-manipulation gap-1.5"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openDemo();
        }}
        onClick={(event) => {
          event.preventDefault();
          openDemo();
        }}
      >
        <Maximize2 className="h-3.5 w-3.5" />
        演示模式
      </button>
      <div className="ui-card w-full max-w-md p-8">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <span className="text-sm font-bold">能</span>
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight text-foreground">能元</div>
            <p className="text-sm text-muted-foreground">
              AI4ES · 请使用管理员分配的账号登录
            </p>
          </div>
        </div>
          <form className="space-y-4" action={loginAction}>
            <input type="hidden" name="next" value={nextPath} />
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">用户名</span>
              <input
                className="ui-input"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="请输入用户名"
                required
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">密码</span>
              <input
                className="ui-input"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                required
              />
            </label>
            <button type="submit" className="ui-btn-primary w-full">
              登录
            </button>
          </form>
      </div>
      {demoAlive && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={cn('cockpit-root is-alive', demoOpen && 'is-open')}
              aria-hidden={demoOpen ? undefined : true}
            >
              <iframe
                className="dv-player"
                title="能元平台运行监测"
                src="/datav/index.html"
                allow="fullscreen"
              />
              {demoOpen ? (
                <>
                  <button type="button" className="dv-close-top" onClick={closeDemo} onPointerDown={(event) => event.stopPropagation()}>
                    <X size={18} />
                    关闭
                  </button>
                  <div className="dv-actions">
                    <button type="button" onClick={closeDemo} onPointerDown={(event) => event.stopPropagation()}>
                      <X size={18} />
                      关闭
                    </button>
                  </div>
                </>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
