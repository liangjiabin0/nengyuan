"use client";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import {
  groupModelFiles,
  MAX_IMPORT_CASES,
  MAX_IMPORT_FILES,
  type ModelFileGroup,
} from "@/lib/power-compute/model-files";
import type { EngineId } from "@/lib/power-compute/catalog";
import type { ImportDiagnosis } from "@/lib/power-compute/imports";

export type ImportedModel = {
  id: string;
  engine: string;
  filename: string;
  diagnosis_json?: string;
};
type ImportRow = {
  key: string;
  group: ModelFileGroup<File>;
  state: "queued" | "uploading" | "ready" | "failed" | "removed";
  error?: string;
};
export type ModelUploadState = { busy: boolean; hasErrors: boolean };

export function PowerModelUpload({
  engine,
  models,
  selectedIds,
  onChange,
  onRefresh,
  onStateChange,
  disabled,
}: {
  engine: EngineId;
  models: ImportedModel[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onRefresh: () => Promise<void>;
  onStateChange: (state: ModelUploadState) => void;
  disabled: boolean;
}) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const current = useRef<{ key: string; controller: AbortController } | null>(
    null,
  );
  const generation = useRef(0),
    rowRef = useRef<ImportRow[]>([]),
    selection = useRef(selectedIds);
  useEffect(() => {
    selection.current = selectedIds;
  }, [selectedIds]);
  useEffect(() => {
    onStateChange({ busy: false, hasErrors: false });
    return () => {
      generation.current += 1;
      current.current?.controller.abort();
      onStateChange({ busy: false, hasErrors: false });
    };
  }, [onStateChange]);
  const updateSelection = (ids: string[]) => {
    selection.current = ids;
    onChange(ids);
  };
  const publish = () => {
    setRows([...rowRef.current]);
    onStateChange({
      busy: rowRef.current.some(
        (r) => r.state === "queued" || r.state === "uploading",
      ),
      hasErrors: rowRef.current.some((r) => r.state === "failed"),
    });
  };
  const updateRow = (key: string, changes: Partial<ImportRow>) => {
    rowRef.current = rowRef.current.map((row) =>
      row.key === key ? { ...row, ...changes } : row,
    );
    publish();
  };
  const clearAll = () => {
    generation.current += 1;
    current.current?.controller.abort();
    current.current = null;
    rowRef.current = [];
    setRows([]);
    setError("");
    updateSelection([]);
    onStateChange({ busy: false, hasErrors: false });
  };
  const removeRow = (key: string) => {
    if (current.current?.key === key) current.current.controller.abort();
    updateRow(key, { state: "removed" });
  };
  const upload = async (files: File[]) => {
    let groups: ModelFileGroup<File>[];
    try {
      groups = groupModelFiles(engine, files);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      onStateChange({ busy: false, hasErrors: true });
      return;
    }
    clearAll();
    const version = generation.current;
    rowRef.current = groups.map((group, index) => ({
      group,
      key: String(index),
      state: "queued",
    }));
    publish();
    for (const item of rowRef.current) {
      if (generation.current !== version) return;
      if (rowRef.current.find((r) => r.key === item.key)?.state === "removed")
        continue;
      const controller = new AbortController();
      current.current = { key: item.key, controller };
      updateRow(item.key, { state: "uploading" });
      try {
        const form = new FormData();
        form.append("file", item.group.primary);
        if (item.group.dynamic) form.append("dynamicFile", item.group.dynamic);
        const response = await fetch("/api/power-models?engine=" + engine, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "导入失败");
        if (generation.current !== version || controller.signal.aborted)
          continue;
        await onRefresh();
        if (generation.current !== version || controller.signal.aborted)
          continue;
        updateSelection([...selection.current, value.model.id]);
        updateRow(item.key, { state: "ready" });
      } catch (reason) {
        if (generation.current === version && !controller.signal.aborted)
          updateRow(item.key, {
            state: "failed",
            error: reason instanceof Error ? reason.message : String(reason),
          });
      } finally {
        if (current.current?.controller === controller) current.current = null;
      }
    }
    if (generation.current === version) publish();
  };
  const pending = rows.some(
    (row) => row.state === "queued" || row.state === "uploading",
  );
  const choices = models.filter((model) => model.engine === engine);
  return (
    <section
      className="space-y-2 rounded-lg bg-muted/30 p-3 text-xs"
      aria-label="模型文件"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">导入计算模型</h3>
        {error ||
        selectedIds.length ||
        rows.some((r) =>
          ["queued", "uploading", "failed"].includes(r.state),
        ) ? (
          <button
            type="button"
            disabled={disabled}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            aria-label={pending ? "取消全部上传" : "移除全部已选模型"}
            onClick={clearAll}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {choices.length ? (
        <label className="block">
          已导入的模型
          <select
            className="ui-input mt-1 h-8 w-full"
            value={selectedIds.length === 1 ? selectedIds[0] : ""}
            disabled={disabled || pending}
            onChange={(e) => {
              clearAll();
              updateSelection(e.target.value ? [e.target.value] : []);
            }}
          >
            <option value="">
              {selectedIds.length > 1
                ? `本批已选 ${selectedIds.length} 个算例`
                : "选择已有模型，或上传文件"}
            </option>
            {choices.map((model) => (
              <option key={model.id} value={model.id}>
                {model.filename}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {selectedIds.map((id) => {
          const model = models.find((m) => m.id === id);
          if (!model) return null;
          const diagnosis = model.diagnosis_json
            ? (JSON.parse(model.diagnosis_json) as ImportDiagnosis)
            : null;
          const names =
            diagnosis?.originals.map((f) => f.name).join(" + ") ||
            model.filename;
          return (
            <div
              key={id}
              className="flex items-start gap-2 rounded border border-border bg-card px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="break-all">{names}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  导入完成
                  {diagnosis?.counts.snapshots
                    ? ` · ${diagnosis.counts.snapshots} 个时段`
                    : ""}
                  {diagnosis?.diagnostics.some(
                    (d) => d.severity?.toLowerCase() === "warning",
                  )
                    ? " · 含转换警告"
                    : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={disabled}
                className="p-1 text-muted-foreground"
                aria-label={"移除模型 " + model.filename}
                onClick={() =>
                  updateSelection(
                    selection.current.filter((value) => value !== id),
                  )
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        {rows
          .filter((row) => !["ready", "removed"].includes(row.state))
          .map((row) => (
            <div
              key={row.key}
              className="flex items-start gap-2 rounded border border-border px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="break-all">
                  {row.group.primary.name}
                  {row.group.dynamic ? " + " + row.group.dynamic.name : ""}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {row.state === "queued"
                    ? "排队导入"
                    : row.state === "uploading"
                      ? "正在导入并检查…"
                      : row.error}
                </p>
              </div>
              {row.state === "uploading" ? (
                <LoaderCircle className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : null}
              <button
                type="button"
                disabled={disabled}
                className="p-1 text-muted-foreground"
                aria-label={"取消文件 " + row.group.primary.name}
                onClick={() => removeRow(row.key)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
      </div>
      <details open={!selectedIds.length && !pending}>
        <summary className="cursor-pointer py-1 text-muted-foreground">
          上传或替换模型文件
        </summary>
        <label className="mt-2 block">
          {engine === "andes"
            ? "选择完整 XLSX，或同时选择配套 RAW 和 DYR"
            : engine === "pypsa"
              ? "选择 PyPSA 网络文件（.nc）"
              : "选择电网模型（.m / .raw / .json / .csv / .xlsx）"}
          <input
            type="file"
            multiple
            accept={
              engine === "andes"
                ? ".xlsx,.raw,.dyr"
                : engine === "pypsa"
                  ? ".nc"
                  : ".m,.raw,.json,.csv,.xlsx"
            }
            disabled={disabled || pending}
            className="mt-2 block w-full text-xs"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files || []);
              e.currentTarget.value = "";
              if (files.length) void upload(files);
            }}
          />
        </label>
        <p className="mt-2 leading-5 text-muted-foreground">
          每批最多 {MAX_IMPORT_FILES} 个文件、{MAX_IMPORT_CASES}{" "}
          个独立算例；每个文件不超过 5
          MB。逐个检查，各自计算，不合并成一张电网。
          {engine === "andes"
            ? "多组 RAW/DYR 须同名配对；只有一组时可使用不同主名。"
            : ""}
        </p>
      </details>
      {error ? (
        <p role="alert" className="leading-5">
          {error}
        </p>
      ) : null}
    </section>
  );
}
