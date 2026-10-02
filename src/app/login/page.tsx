import { Suspense } from 'react';
import { LoginForm } from '@/components/login-form';

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-sm text-slate-500">加载中…</div>}>
      <LoginForm />
    </Suspense>
  );
}
