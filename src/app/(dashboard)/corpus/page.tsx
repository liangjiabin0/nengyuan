import { PageFrame } from '@/components/page-frame';
import { CorpusBrowser } from '@/components/corpus-browser';

export default function CorpusPage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <CorpusBrowser />
    </PageFrame>
  );
}
