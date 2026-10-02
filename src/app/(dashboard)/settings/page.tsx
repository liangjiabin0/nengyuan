import { Suspense } from 'react';
import { AdminGate } from '@/components/admin-gate';
import { PageFrame } from '@/components/page-frame';
import { SettingsForm } from '@/components/settings-form';

export default function SettingsPage() {
  return (
    <AdminGate>
      <PageFrame fullHeight padded={false} className="h-full">
        <Suspense
          fallback={
            <div className="rag-shell flex h-full min-h-0 flex-1 items-center justify-center p-3 text-sm text-muted-foreground md:p-4">
              正在加载设置…
            </div>
          }
        >
          <SettingsForm />
        </Suspense>
      </PageFrame>
    </AdminGate>
  );
}
