import manifest from "../../../tools/power-mcp/capabilities.json";
export const POWER_TASKS = manifest.tasks;
export function powerTaskLabel(
  parameters: Record<string, unknown>,
  engine: string,
) {
  return (
    POWER_TASKS.find((t) => t.id === parameters.analysis)?.label ||
    POWER_ENGINES[engine as EngineId]?.label ||
    engine
  );
}
export const POWER_ENGINES = {
  pandapower: {
    label: "潮流与越限校核",
    name: "pandapower",
    description: "标准电网 AC 潮流，核对节点电压与线路负载。",
    models: [
      ["ieee9", "IEEE 9 节点"],
      ["ieee14", "IEEE 14 节点"],
    ],
  },
  pypsa: {
    label: "多时段储能优化",
    name: "PyPSA / HiGHS",
    description: "按 24 小时负荷、电价与储能约束优化运行。",
    models: [["park-24h", "园区储能 · 24 × 1 h"]],
  },
  andes: {
    label: "电力系统动态分析",
    name: "ANDES",
    description: "Kundur 动态模型的三相故障与清除响应。",
    models: [["kundur-full", "Kundur 完整动态模型"]],
  },
} as const;
export type EngineId = keyof typeof POWER_ENGINES;
export function defaultPowerParameters(
  engine: EngineId,
): Record<string, unknown> {
  if (engine === "pandapower")
    return {
      loadFactor: 1,
      voltageMinPu: 0.95,
      voltageMaxPu: 1.05,
      loadingMaxPercent: 100,
      toleranceMva: 1e-8,
    };
  if (engine === "andes")
    return {
      busId: 5,
      faultAtS: 1,
      clearAtS: 1.1,
      endAtS: 10,
      stepS: 0.01,
      voltageMinPu: 0.95,
      voltageMaxPu: 1.05,
      recoverWithinS: 3,
      holdS: 1,
    };
  return {
    date: "2026-10-16",
    timezone: "Asia/Shanghai",
    loadsKw: [
      230, 220, 215, 210, 220, 240, 280, 320, 350, 380, 400, 390, 370, 360, 380,
      410, 440, 460, 450, 430, 380, 330, 280, 250,
    ],
    prices: [
      0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.75, 0.75, 0.75, 0.75, 0.75,
      0.75, 0.75, 0.75, 0.75, 1.2, 1.2, 1.2, 1.2, 1.2, 0.75, 0.75, 0.75,
    ],
    capacityKwh: 500,
    powerKw: 100,
    gridLimitKw: 1000,
    efficiencyCharge: 0.95,
    efficiencyDischarge: 0.95,
    socMin: 0.1,
    socMax: 0.9,
    initialSoc: 0.5,
    terminalSoc: 0.5,
  };
}
export const POWER_PHASES: Record<string, string> = {
  queued: "排队中",
  infeasible: "不可行",
  nonconverged: "不收敛",
  preparing: "准备输入",
  connecting: "连接计算服务",
  loading: "载入模型",
  solving: "执行计算",
  checking: "校验结果",
  saved: "保存产物",
  running: "运行中",
  cancel_requested: "正在停止",
  succeeded: "计算完成",
  failed: "执行失败",
  cancelled: "已取消",
  timed_out: "已超时",
};

export function defaultTaskParameters(
  analysis: string,
): Record<string, unknown> {
  const task = POWER_TASKS.find((t) => t.id === analysis);
  if (!task) throw new Error("未知实验类型");
  const base = { ...defaultPowerParameters(task.engine as EngineId), analysis };
  if (task.engine === "pandapower")
    return {
      ...base,
      algorithm: "nr",
      maxIterations: 30,
      calculateAngles: true,
    };
  if (task.engine === "andes" && analysis === "small_signal")
    return { analysis };
  if (task.engine === "pypsa") {
    const solarProfile = [
      0, 0, 0, 0, 0, 0, 0.05, 0.2, 0.4, 0.6, 0.8, 0.9, 1, 0.9, 0.8, 0.6, 0.4,
      0.2, 0.05, 0, 0, 0, 0, 0,
    ];
    return {
      ...base,
      stepMinutes: 60,
      ...(analysis === "economic_dispatch" || analysis === "unit_commitment"
        ? { generatorKw: 400, generatorCost: 0.6 }
        : {}),
      ...(analysis === "unit_commitment"
        ? { startupCost: 50, minUpSteps: 2, minDownSteps: 1, rampPerStep: 0.5 }
        : {}),
      ...(analysis === "capacity_expansion"
        ? {
            solarProfile,
            solarMaxKw: 1000,
            solarAnnualCost: 350,
            storageMaxKw: 0,
            storageAnnualCost: 500,
          }
        : {}),
    };
  }
  return base;
}
