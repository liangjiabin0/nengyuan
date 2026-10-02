import { PageFrame } from '@/components/page-frame';
import { VirtualSimWorkbench } from '@/components/virtual-sim-workbench';

export default function VirtualSimPage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <VirtualSimWorkbench />
    </PageFrame>
  );
}
