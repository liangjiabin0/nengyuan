'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, KeyboardEvent, useEffect, useState } from 'react';
import { startPageNav } from '@/components/page-nav-loading';

export function WorkbenchChatCard({ initialQuestion = '' }: { initialQuestion?: string }) {
  const router = useRouter();
  const [question, setQuestion] = useState(initialQuestion);

  useEffect(() => {
    setQuestion(initialQuestion);
  }, [initialQuestion]);

  function openChat() {
    const trimmed = question.trim();
    const href = trimmed ? `/chat?question=${encodeURIComponent(trimmed)}` : '/chat';
    startPageNav(href);
    router.push(href);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openChat();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    openChat();
  }

  return (
    <div className="ui-card flex h-full min-h-[220px] flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="ui-kicker">Chat</div>
          <h2 className="ui-section-title mt-1">快速提问</h2>
        </div>
        <button type="button" onClick={openChat} className="ui-btn-secondary shrink-0 px-3 py-1.5 text-xs">打开</button>
      </div>
      <form onSubmit={submit} className="mt-3 flex flex-1 flex-col gap-2">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder="输入问题，Enter 跳转对话页"
          className="ui-input min-h-[5.5rem] flex-1 resize-none bg-slate-50"
        />
        <div className="flex justify-end">
          <button type="submit" className="ui-btn-primary">发送</button>
        </div>
      </form>
    </div>
  );
}
