"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatModelMenu } from "@/components/chat-model-menu";
import {
  fallbackThinkingLevels,
  resolveThinkingLevel,
  type ThinkingLevel,
} from "@/lib/thinking-levels-core";
import type { ChatModelId } from "@/lib/model-ids";

export function SchemeModelPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: { chatModel: ChatModelId; thinkingId: string };
  onChange: (value: { chatModel: ChatModelId; thinkingId: string }) => void;
  disabled?: boolean;
}) {
  const [ratio, setRatio] = useState(0.5);
  const [catalog, setCatalog] = useState<
    Record<string, { levels?: ThinkingLevel[] }>
  >({});
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/thinking-levels", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : {}))
      .then(setCatalog)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  const levels = useMemo(
    () =>
      catalog[value.chatModel]?.levels ||
      fallbackThinkingLevels(value.chatModel),
    [value.chatModel, catalog],
  );
  return (
    <ChatModelMenu
      value={value.chatModel}
      disabled={disabled}
      reasoningRatio={ratio}
      thinkingLevels={levels}
      onModelChange={(chatModel) =>
        onChange({
          chatModel,
          thinkingId: resolveThinkingLevel(
            ratio,
            catalog[chatModel]?.levels || fallbackThinkingLevels(chatModel),
          ).id,
        })
      }
      onReasoningChange={(next) => {
        setRatio(next);
        onChange({
          ...value,
          thinkingId: resolveThinkingLevel(next, levels).id,
        });
      }}
    />
  );
}
