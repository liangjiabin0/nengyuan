import { defaultTaskParameters, POWER_TASKS, type EngineId } from "./catalog";

export const parameterLabels: Record<string, string> = {
  date: "计算开始日期",
  timezone: "时间口径",
  stepMinutes: "每个时段 / 分钟",
  loadsKw: "各时段负荷 / kW",
  prices: "各时段购电价 / 元每 kWh",
  solarProfile: "各时段光伏出力系数 / 0—1",
  windProfile: "各时段风电出力系数 / 0—1",
  capacityKwh: "储能容量 / kWh",
  powerKw: "储能功率 / kW",
  gridLimitKw: "购电功率上限 / kW",
  efficiencyCharge: "充电效率",
  efficiencyDischarge: "放电效率",
  socMin: "SOC 下限",
  socMax: "SOC 上限",
  initialSoc: "初始 SOC",
  terminalSoc: "末 SOC",
  solarKw: "已有光伏 / kW",
  windKw: "已有风电 / kW",
  generatorKw: "常规机组 / kW",
  generatorCost: "机组发电成本 / 元每 kWh",
  startupCost: "启动成本 / 元每次",
  minUpSteps: "最少连续开机时段",
  minDownSteps: "最少连续停机时段",
  rampPerStep: "每时段爬坡比例",
  solarMaxKw: "最多新增光伏 / kW",
  windMaxKw: "最多新增风电 / kW",
  storageMaxKw: "最多新增储能功率 / kW",
  solarAnnualCost: "光伏年化成本 / 元每 kW",
  windAnnualCost: "风电年化成本 / 元每 kW",
  storageAnnualCost: "储能年化成本 / 元每 kW",
};

export function defaultModelId(engine: EngineId) {
  return engine === "pypsa" ? "custom-timeseries" : "uploaded";
}

// Sample fixtures stay in the catalog. Production drafts never inherit their data.
export function productionParameters(
  analysis: string,
  now = new Date(),
): Record<string, unknown> {
  const engine = POWER_TASKS.find((t) => t.id === analysis)?.engine;
  if (engine !== "pypsa")
    return {
      ...defaultTaskParameters(analysis),
      ...(analysis === "time_domain" ? { busId: null } : {}),
    };
  return {
    analysis,
    date: new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10),
    timezone: "Asia/Shanghai",
    stepMinutes: 60,
    loadsKw: [],
    prices: [],
    gridLimitKw: null,
    capacityKwh: null,
    powerKw: null,
    efficiencyCharge: 0.95,
    efficiencyDischarge: 0.95,
    socMin: 0.1,
    socMax: 0.9,
    initialSoc: 0.5,
    terminalSoc: 0.5,
    solarKw: 0,
    windKw: 0,
    generatorKw: analysis === "unit_commitment" ? null : 0,
    generatorCost: null,
    startupCost: null,
    minUpSteps: 2,
    minDownSteps: 1,
    rampPerStep: 0.5,
    solarMaxKw: 0,
    windMaxKw: 0,
    storageMaxKw: 0,
    solarAnnualCost: null,
    windAnnualCost: null,
    storageAnnualCost: null,
  };
}

export function planningFields(p: Record<string, unknown>) {
  const battery = ["storage_dispatch", "capacity_expansion"].includes(
    String(p.analysis),
  );
  const expansion = p.analysis === "capacity_expansion";
  return [
    "date",
    "timezone",
    "stepMinutes",
    "gridLimitKw",
    ...(battery
      ? [
          "capacityKwh",
          "powerKw",
          "efficiencyCharge",
          "efficiencyDischarge",
          "socMin",
          "socMax",
          "initialSoc",
          "terminalSoc",
        ]
      : []),
    "solarKw",
    "windKw",
    "generatorKw",
    ...(Number(p.generatorKw) > 0 || p.analysis === "unit_commitment"
      ? ["generatorCost"]
      : []),
    ...(p.analysis === "unit_commitment"
      ? ["startupCost", "minUpSteps", "minDownSteps", "rampPerStep"]
      : []),
    ...(expansion
      ? [
          "solarMaxKw",
          "windMaxKw",
          "storageMaxKw",
          ...(Number(p.solarMaxKw) > 0 ? ["solarAnnualCost"] : []),
          ...(Number(p.windMaxKw) > 0 ? ["windAnnualCost"] : []),
          ...(Number(p.storageMaxKw) > 0 ? ["storageAnnualCost"] : []),
        ]
      : []),
  ];
}

export function planningSeries(p: Record<string, unknown>) {
  return [
    "loadsKw",
    "prices",
    ...(Number(p.solarKw) > 0 ||
    (p.analysis === "capacity_expansion" && Number(p.solarMaxKw) > 0)
      ? ["solarProfile"]
      : []),
    ...(Number(p.windKw) > 0 ||
    (p.analysis === "capacity_expansion" && Number(p.windMaxKw) > 0)
      ? ["windProfile"]
      : []),
  ];
}

export function parseSeries(text: string, label: string): number[] {
  const tokens = text
    .trim()
    .split(/[,，;；\s]+/)
    .filter(Boolean);
  if (tokens.length < 2 || tokens.length > 8760)
    throw new Error(`${label}：请填写 2—8760 个时段，可从 Excel 复制一列数据`);
  return tokens.map((token, i) => {
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token) ||
      !Number.isFinite(Number(token))
    )
      throw new Error(`${label}：第 ${i + 1} 个值不是有效数字`);
    return Number(token);
  });
}

export function prepareParameters(
  engine: EngineId,
  modelId: string,
  p: Record<string, unknown>,
  drafts: Record<string, string>,
) {
  if (engine === "pypsa" && modelId === "uploaded")
    return { analysis: p.analysis };
  if (engine !== "pypsa") {
    for (const [key, value] of Object.entries(p))
      if (value === null || value === "")
        throw new Error(
          key === "busId" ? "请填写算例中的故障母线编号" : "请填写完整计算参数",
        );
    return p;
  }
  const keys = planningFields(p);
  const prepared: Record<string, unknown> = { analysis: p.analysis };
  for (const key of keys) {
    const value = p[key];
    if (value === null || value === "")
      throw new Error(`请填写${parameterLabels[key] || key}`);
    if (value !== undefined) prepared[key] = value;
  }
  for (const key of planningSeries(p))
    prepared[key] = parseSeries(
      drafts[key] ?? (Array.isArray(p[key]) ? p[key].join(",") : ""),
      parameterLabels[key],
    );
  return prepared;
}

export function modelLabel(modelId: string) {
  return (
    (
      {
        "custom-timeseries": "填写的数据",
        "park-24h": "园区储能示例",
        ieee9: "IEEE 9 节点示例",
        ieee14: "IEEE 14 节点示例",
        "kundur-full": "Kundur 动态示例",
        uploaded: "导入的模型",
      } as Record<string, string>
    )[modelId] || modelId
  );
}
