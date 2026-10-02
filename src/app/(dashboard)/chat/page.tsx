import { Suspense } from 'react';
import { ChatWorkbench } from '@/components/chat-workbench';
import { PageFrame } from '@/components/page-frame';

export default function ChatPage() {
  return (
    <PageFrame fullHeight padded={false} className="h-full">
      <Suspense fallback={<div className="ui-card m-4 p-4 text-sm text-slate-500">正在加载对话...</div>}>
        <ChatWorkbench />
      </Suspense>
    </PageFrame>
  );
}
