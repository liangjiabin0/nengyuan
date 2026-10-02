import { AdminGate } from '@/components/admin-gate';
import { PageFrame } from '@/components/page-frame';
import { RecordsTable } from '@/components/records-table';

export default function TablesPage() {
  return (
    <AdminGate>
      <PageFrame fullHeight padded={false} className="h-full">
        <RecordsTable />
      </PageFrame>
    </AdminGate>
  );
}
