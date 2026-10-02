import { AdminGate } from '@/components/admin-gate';
import { AdminUsersPanel } from '@/components/admin-users-panel';
import { PageFrame } from '@/components/page-frame';

export default function AdminUsersPage() {
  return (
    <AdminGate>
      <PageFrame fullHeight padded={false} className="h-full">
        <AdminUsersPanel />
      </PageFrame>
    </AdminGate>
  );
}
