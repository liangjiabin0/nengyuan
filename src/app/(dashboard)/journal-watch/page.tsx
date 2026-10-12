import { PageFrame } from '@/components/page-frame';
import { JournalWatchPage } from '@/components/journal-watch-page';

export default function JournalWatchRoute() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <JournalWatchPage />
    </PageFrame>
  );
}
