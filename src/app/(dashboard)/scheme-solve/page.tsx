import { SchemeSolveWorkbench } from '@/components/scheme-solve-workbench';
import { PageFrame } from '@/components/page-frame';

export default function SchemeSolvePage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <SchemeSolveWorkbench />
    </PageFrame>
  );
}
