import type { PowerEngine } from "./schema";

const reminders: Record<PowerEngine, number> = {
  pandapower: 10 * 60_000,
  pypsa: 2 * 60 * 60_000,
  andes: 2 * 60 * 60_000,
};
export function powerTimeoutPolicy(
  engine: PowerEngine,
  env: Record<string, string | undefined> = process.env,
) {
  const key = engine.toUpperCase();
  const positive = (raw: string | undefined, fallback: number) => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      throw new Error("计算时限配置必须为非负毫秒数");
    return Math.min(value, 7 * 24 * 60 * 60_000);
  };
  return {
    reminderMs: positive(
      env[`POWER_MCP_${key}_REMINDER_MS`],
      reminders[engine],
    ),
    // No elapsed-time termination by default. An administrator can opt in per engine.
    hardLimitMs: positive(
      env[`POWER_MCP_${key}_HARD_TIMEOUT_MS`] ?? env.POWER_MCP_TIMEOUT_MS,
      0,
    ),
  };
}
