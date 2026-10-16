"use client";
import { useCallback, useEffect, useState } from "react";
import type { ComponentHealth } from "@/lib/power-compute/health";
const components = [
  ["powermcp", "PowerMCP", "受控工具调用"],
  ["powerio", "PowerIO", "共享算例导入与转换"],
  ["pandapower", "pandapower", "潮流、最优潮流与安全校核"],
  ["pypsa", "PyPSA", "规划与多时段调度"],
  ["andes", "ANDES", "动态稳定分析"],
];
export function PowerEngineSettings() {
  const [items, setItems] = useState<Record<string, ComponentHealth>>({}),
    [pending, setPending] = useState<string[]>([]);
  const check = useCallback((id: string, refresh = false) => {
    setPending((p) => [...p.filter((k) => k !== id), id]);
    void fetch(
      "/api/system/power-engines?component=" +
        id +
        (refresh ? "&refresh=1" : ""),
      { cache: "no-store" },
    )
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        setItems((p) => ({ ...p, [id]: d }));
      })
      .catch(() =>
        setItems((p) => ({
          ...p,
          [id]: {
            component: id,
            status: "unavailable",
            version: null,
            checkedAt: new Date().toISOString(),
            error: "读取失败，请检查权限或稍后重试",
          },
        })),
      )
      .finally(() => setPending((p) => p.filter((k) => k !== id)));
  }, []);
  useEffect(() => {
    components.forEach(([id]) => check(id));
  }, [check]);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <h2 className="font-medium">计算引擎与 MCP</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        只读检查组件版本、导入接口与依赖。可用状态不代替具体算例验收。
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {components.map(([id, name, description]) => (
          <section key={id} className="rounded-xl border border-border p-4">
            <div className="flex items-center justify-between">
              <strong>{name}</strong>
              <button
                className="ui-btn-secondary h-7 text-xs"
                disabled={pending.includes(id)}
                onClick={() => check(id, true)}
              >
                {pending.includes(id) ? "检查中…" : "重新检查"}
              </button>
            </div>
            <p className="mt-2 text-xs">{description}</p>
            <p className="mt-2 text-xs">
              {items[id]
                ? `${items[id].status === "available" ? "可用" : "异常"} · ${items[id].version || "版本未知"}`
                : "等待检查"}
            </p>
            {items[id]?.error ? (
              <p role="alert" className="mt-2 text-xs">
                {items[id].error}
              </p>
            ) : null}
            <p className="mt-2 text-[11px] text-muted-foreground">
              {items[id]?.checkedAt
                ? new Date(items[id].checkedAt).toLocaleString()
                : ""}
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}
