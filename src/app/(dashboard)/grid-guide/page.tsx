import { GridGuideWorkbench } from '@/components/grid-guide-workbench';
import { PageFrame } from '@/components/page-frame';

export default function GridGuidePage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <GridGuideWorkbench />
    </PageFrame>
  );
}
