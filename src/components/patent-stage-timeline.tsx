'use client';

import { CheckCircle2, Circle, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { PatentProject, PatentStage } from '@/lib/patent-generation/types';

const STAGES: Array<{ id: PatentStage; label: string }> = [
  { id: 'source', label: '安全解析' },
  { id: 'clarification', label: '交底澄清' },
  { id: 'prior_art', label: '现有技术' },
  { id: 'strategy', label: '保护策略' },
  { id: 'specification', label: '申请文件' },
  { id: 'drawings', label: '说明书附图' },
  { id: 'audit', label: '质量审校' }
];

const ORDER = new Map(STAGES.map((item, index) => [item.id, index]));

export function PatentStageTimeline({ project }: { project: PatentProject }) {
  const terminal = ['ready', 'completed', 'review_required'].includes(project.status);
  const completedByArtifact: Record<string, boolean> = {
    source: Boolean(project.source),
    clarification: Boolean(project.disclosure && project.clarification),
    prior_art: Boolean(project.priorArt),
    strategy: Boolean(project.strategy),
    specification: Boolean(project.draft),
    drawings: Boolean(project.drawings),
    audit: Boolean(project.audit)
  };
  const firstIncomplete = STAGES.findIndex((item) => !completedByArtifact[item.id]);
  const current = ORDER.get(project.currentStage) ?? (firstIncomplete < 0 ? STAGES.length : firstIncomplete);
  const failed = ['failed', 'cancelled', 'interrupted'].includes(project.status);
  const running = project.status === 'queued' || project.status === 'processing';

  return (
    <ol className="space-y-2" aria-label="专利生成阶段">
      {STAGES.map((stage, index) => {
        const completed = terminal || completedByArtifact[stage.id];
        const active = index === current && running;
        const broken = index === current && failed;
        return (
          <li key={stage.id} className="flex items-center gap-2 text-xs">
            {completed ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            ) : active ? (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            ) : broken ? (
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            )}
            <span className={active ? 'font-medium text-foreground' : 'text-muted-foreground'}>
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
