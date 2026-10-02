import { PageFrame } from '@/components/page-frame';
import { SkillLibrary } from '@/components/skill-library';

export default function SkillsPage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <SkillLibrary />
    </PageFrame>
  );
}
