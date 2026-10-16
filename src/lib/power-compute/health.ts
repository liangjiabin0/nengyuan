import { execFile } from "node:child_process";
import path from "node:path";
import { powerPython, diagnosticEnvironment } from "./environment";
export const POWER_COMPONENTS = [
  "powermcp",
  "powerio",
  "pandapower",
  "pypsa",
  "andes",
] as const;
export type ComponentHealth = {
  component: string;
  status: "available" | "unavailable";
  version: string | null;
  error?: string;
  checkedAt: string;
};
const CACHE_TTL_MS = 60000;
const REFRESH_THROTTLE_MS = 5000;
const cache = new Map<
  string,
  { expires: number; startedAt: number; value: Promise<ComponentHealth> }
>();
export function checkComponent(
  component: string,
  refresh = false,
): Promise<ComponentHealth> {
  if (
    !POWER_COMPONENTS.includes(component as (typeof POWER_COMPONENTS)[number])
  )
    throw new Error("未知组件");
  const cached = cache.get(component);
  if (
    cached &&
    (!refresh || Date.now() - cached.startedAt < REFRESH_THROTTLE_MS) &&
    cached.expires > Date.now()
  )
    return cached.value;
  const value = new Promise<ComponentHealth>((resolve) => {
    execFile(
      powerPython(),
      [path.resolve("tools/power-mcp/health.py"), component],
      {
        timeout: 20000,
        maxBuffer: 65536,
        windowsHide: true,
        env: diagnosticEnvironment(path.resolve("storage/power-cache")),
      },
      (error, stdout) => {
        const checkedAt = new Date().toISOString();
        try {
          const data = JSON.parse(
            stdout.trim().split("\n").at(-1) || "null",
          ) as ComponentHealth;
          if (
            data.component !== component ||
            !["available", "unavailable"].includes(data.status)
          )
            throw new Error();
          resolve({ ...data, checkedAt });
        } catch {
          resolve({
            component,
            status: "unavailable",
            version: null,
            checkedAt,
            error: error?.killed
              ? "检查超时，可稍后重试"
              : "检查失败，请联系管理员查看部署日志",
          });
        }
      },
    );
  });
  cache.set(component, {
    expires: Date.now() + CACHE_TTL_MS,
    startedAt: Date.now(),
    value,
  });
  return value;
}
