'use client';

import { RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

type ChatMessageActionsProps = {
  align: 'user' | 'assistant';
  alwaysVisible?: boolean;
  canResend?: boolean;
  disabled?: boolean;
  onRevert: () => void | Promise<void>;
  onResend?: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
};

export function ChatMessageActions({
  align,
  alwaysVisible = false,
  canResend = true,
  disabled = false,
  onRevert,
  onResend,
  onDelete
}: ChatMessageActionsProps) {
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy;

  async function run(action: () => void | Promise<void>) {
    if (locked) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        'rag-msg-actions',
        alwaysVisible && 'rag-msg-actions-enter',
        align === 'user' ? 'justify-end' : 'justify-start'
      )}
      data-visible={alwaysVisible ? 'true' : undefined}
    >
      <button
        type="button"
        disabled={locked}
        onClick={() => run(onRevert)}
        className="rag-msg-action-btn"
        title="回撤到此条之前"
        aria-label="回撤到此条之前"
      >
        <Undo2 />
      </button>
      {canResend && onResend ? (
        <button
          type="button"
          disabled={locked}
          onClick={() => run(onResend)}
          className="rag-msg-action-btn"
          title="重新发送"
          aria-label="重新发送"
        >
          <RotateCcw />
        </button>
      ) : null}
      <button
        type="button"
        disabled={locked}
        onClick={() => run(onDelete)}
        className="rag-msg-action-btn rag-msg-action-btn-danger"
        title="删除这条消息"
        aria-label="删除这条消息"
      >
        <Trash2 />
      </button>
    </div>
  );
}
