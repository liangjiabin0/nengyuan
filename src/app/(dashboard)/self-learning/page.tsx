import { PageFrame } from '@/components/page-frame';
import { SelfLearningMemoryPage } from '@/components/self-learning-memory-page';

export default function SelfLearningPage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <SelfLearningMemoryPage />
    </PageFrame>
  );
}
