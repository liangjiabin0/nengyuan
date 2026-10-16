"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, X } from "lucide-react";
import { powerTaskLabel, POWER_PHASES } from "@/lib/power-compute/catalog";
import type { PowerRun } from "@/lib/power-compute/store";

export function PowerTaskIndicator() {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<PowerRun[]>([]);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/power-runs", { cache: "no-store" });
        if (!response.ok) throw new Error("任务状态暂时无法读取");
        const data = await response.json();
        if (!disposed) {
          setRuns(data.runs);
          setError("");
        }
      } catch (caught) {
        if (!disposed) setError(String(caught));
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    const created = () => {
      void refresh();
    };
    window.addEventListener("power-run-created", created);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("power-run-created", created);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open]);
  const active = runs.filter((run) =>
    ["queued", "running", "cancel_requested"].includes(run.status),
  );
  return (
    <div className="relative shrink-0" ref={root}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="power-task-popup"
        className="ui-btn-secondary h-8 gap-1.5 px-2.5 text-xs"
        onClick={() => setOpen((value) => !value)}
      >
        {active.length ? (
          <LoaderCircle className="h-3 w-3 animate-spin" />
        ) : null}
        任务{active.length ? ` · ${active.length}` : ""}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <section
          id="power-task-popup"
          aria-label="电力计算任务"
          className="absolute right-0 top-10 z-50 w-[320px] max-w-[85vw] rounded-xl border border-border bg-background shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <strong className="text-xs">电力计算任务</strong>
            <button aria-label="收起任务卡片" onClick={() => setOpen(false)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <div className="max-h-[50vh] overflow-auto p-2">
            {error ? (
              <p role="alert" className="p-2 text-xs">
                {error}
              </p>
            ) : null}
            {runs.slice(0, 12).map((run) => (
              <a
                key={run.id}
                href={
                  run.sessionId
                    ? "/scheme-solve?schemeId=" +
                      run.sessionId +
                      "&schemeIdea=" +
                      (run.ideaId || "") +
                      "&powerRun=" +
                      run.id
                    : "/virtual-sim" + "?powerRun=" + run.id
                }
                className="block rounded-lg p-2.5 hover:bg-muted"
              >
                <div className="flex justify-between gap-2 text-xs">
                  <strong>
                    {powerTaskLabel(run.spec.parameters, run.spec.engine)}
                  </strong>
                  <span>{POWER_PHASES[run.status]}</span>
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {run.spec.modelId} · {run.id.slice(0, 8)} ·{" "}
                  {new Date(run.createdAt).toLocaleString()}
                </p>
              </a>
            ))}
            {!runs.length && !error ? (
              <p className="p-3 text-xs text-muted-foreground">
                尚无电力计算任务。可在设计节点或虚拟仿真中创建。
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
