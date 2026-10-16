"use client";
import { downloadChart } from "@/lib/power-compute/chart-export";
import { useEffect, useState, useRef } from "react";
const tableLabels: Record<string, string> = {
  buses: "母线结果",
  branches: "支路结果",
  violations: "越限记录",
  scenarios: "故障场景",
  dispatch: "出力明细",
  capacities: "设备容量",
  storage: "储能明细",
  links: "转换设备",
  modes: "模态结果",
  participation: "参与因子",
  dynamic: "动态轨迹",
};
const columnLabels: Record<string, string> = {
  id: "编号",
  object: "对象",
  metric: "指标",
  value: "数值",
  voltagePu: "电压 / p.u.",
  angleDegree: "相角 / °",
  loadingPercent: "负载率 / %",
  outage: "退出设备",
  status: "状态",
  violations: "越限数",
  minVoltagePu: "最低电压 / p.u.",
  maxLoadingPercent: "最高负载率 / %",
  hour: "时间 / h",
  timeS: "时间 / s",
  speedPu: "转速 / p.u.",
  gridKw: "购电 / kW",
  solarKw: "光伏 / kW",
  windKw: "风电 / kW",
  thermalKw: "常规机组 / kW",
  chargeKw: "充电 / kW",
  dischargeKw: "放电 / kW",
  soc: "SOC",
  thermalStatus: "开机状态",
  device: "设备",
  capacityKw: "总容量 / kW",
  addedKw: "新增容量 / kW",
  component: "设备类型",
  nominal: "总容量",
  added: "新增容量",
  unit: "单位",
  powerMw: "功率 / MW",
  energyMwh: "电量 / MWh",
  port: "端口",
  mode: "模态",
  real: "实部",
  imaginary: "虚部",
  frequencyHz: "频率 / Hz",
  dampingPercent: "阻尼比 / %",
  kind: "模态类型",
  state: "状态变量",
  factor: "参与因子",
};
const cellLabels: Record<string, string> = {
  converged: "收敛",
  nonconverged_or_island: "不收敛或孤岛",
  oscillatory: "振荡",
  non_oscillatory: "非振荡",
  voltagePu: "电压",
  loadingPercent: "负载率",
  grid: "电网",
  solar: "光伏",
  wind: "风电",
  thermal: "常规机组",
  battery: "储能",
  generators: "发电机",
  loads: "负荷",
  storage_units: "储能单元",
  stores: "能量存储",
  links: "转换设备",
  lines: "线路",
};
export function PowerResultTable({
  name,
  rows,
  total,
  runId,
}: {
  name: string;
  rows: Array<Record<string, string | number>>;
  total?: number;
  runId: string;
}) {
  const [page, setPage] = useState(0),
    [open, setOpen] = useState(false),
    [remote, setRemote] = useState<Array<
      Record<string, string | number>
    > | null>(null),
    [error, setError] = useState("");
  const size = 25,
    pages = Math.ceil((total ?? rows.length) / size);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setRemote(null);
    setError("");
    void fetch(
      "/api/power-runs/" +
        runId +
        "/tables/" +
        encodeURIComponent(name) +
        "?page=" +
        page +
        "&size=" +
        size,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        if (!disposed) setRemote(value.rows);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [open, page, runId, name]);
  if (!rows.length) return null;
  return (
    <details
      className="my-3 text-xs"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer py-2">
        {tableLabels[name] || name} · {total ?? rows.length} 条
      </summary>
      {error ? <p role="alert">{error}</p> : null}
      {open && !remote && !error ? <p>读取中…</p> : null}
      <div className="overflow-auto">
        <table className="w-full text-left text-[10px]">
          <thead>
            <tr>
              {Object.keys(rows[0]).map((k) => (
                <th className="p-2" key={k}>
                  {columnLabels[k] || k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(remote || []).map((row, i) => (
              <tr key={i}>
                {Object.values(row).map((v, j) => (
                  <td className="border-t border-border p-2" key={j}>
                    {typeof v === "number"
                      ? v.toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })
                      : cellLabels[v] || v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="mt-2 flex items-center gap-3">
          <button
            className="ui-btn-secondary h-7"
            disabled={!page}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button
            className="ui-btn-secondary h-7"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}
    </details>
  );
}
export function EigenvalueChart({
  modes,
}: {
  modes: Array<Record<string, string | number>>;
}) {
  const chart = useRef<SVGSVGElement>(null);
  const real = modes.map((m) => Number(m.real)),
    imag = modes.map((m) => Number(m.imaginary));
  if (!modes.length) return null;
  const xmin = Math.min(...real, 0) - 1,
    xmax = Math.max(...real, 0) + 1,
    ymax = Math.max(...imag.map(Math.abs), 1) * 1.1;
  const x = (v: number) => 45 + ((v - xmin) / (xmax - xmin)) * 450,
    y = (v: number) => 95 - (v / ymax) * 75;
  return (
    <section className="my-4 rounded-lg border border-border p-3 text-xs">
      <strong>特征值分布</strong>
      <button
        className="ml-3 underline"
        onClick={() => downloadChart(chart.current, "eigenvalues.svg")}
      >
        导出图表
      </button>
      <svg
        ref={chart}
        xmlns="http://www.w3.org/2000/svg"
        className="mt-2 w-full"
        viewBox="0 0 520 195"
        role="img"
        aria-label="特征值复平面分布"
      >
        <path
          d={`M45 95H500 M${x(0)} 20V170`}
          fill="none"
          stroke="currentColor"
          opacity=".2"
        />
        {modes.map((m, i) => (
          <circle
            key={i}
            cx={x(real[i])}
            cy={y(imag[i])}
            r="2.5"
            fill="currentColor"
          >
            <title>{`模态 ${m.mode}: ${real[i]} + j${imag[i]}`}</title>
          </circle>
        ))}
        <text x="45" y="187" fontSize="10">
          实部 {xmin.toFixed(2)}
        </text>
        <text x="500" y="187" textAnchor="end" fontSize="10">
          {xmax.toFixed(2)} · 虚部 ±{ymax.toFixed(2)}
        </text>
      </svg>
    </section>
  );
}
