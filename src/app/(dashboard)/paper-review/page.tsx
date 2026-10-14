import { PageFrame } from '@/components/page-frame';
import { PaperReviewWorkbench } from '@/components/paper-review-workbench';

export default function PaperReviewPage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <PaperReviewWorkbench />
    </PageFrame>
  );
}
