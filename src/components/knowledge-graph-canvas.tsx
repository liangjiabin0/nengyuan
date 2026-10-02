'use client';

import dynamic from 'next/dynamic';

function GraphCanvasFallback() {
  return (
    <div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
      正在加载图谱引擎…
    </div>
  );
}

export const KnowledgeGraphView = dynamic(
  () => import('@/components/g6-graph-canvas').then((mod) => mod.KnowledgeGraphView),
  { ssr: false, loading: GraphCanvasFallback }
);
