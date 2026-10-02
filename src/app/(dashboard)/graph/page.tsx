import { PageFrame } from '@/components/page-frame';
import { KnowledgeGraphWorkbench } from '@/components/knowledge-graph-view';

export default function GraphPage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
        <div className="mb-3 shrink-0 md:mb-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            Dashboard / Graph
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">学科研究图谱</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            用于查看学科知识之间的关联，并分析研究主题、时间演化和团队结构。
          </p>
        </div>
        <KnowledgeGraphWorkbench />
      </div>
    </PageFrame>
  );
}
