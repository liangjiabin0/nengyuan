import { PptVoiceWorkbench } from '@/components/ppt-voice-workbench';
import { PageFrame } from '@/components/page-frame';

export default function PptVoicePage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <PptVoiceWorkbench />
    </PageFrame>
  );
}
