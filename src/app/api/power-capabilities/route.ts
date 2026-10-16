import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/request";
import { checkComponent } from "@/lib/power-compute/health";
import manifest from "../../../../tools/power-mcp/capabilities.json";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const url = new URL(request.url),
    engine = url.searchParams.get("engine") || "",
    transport =
      url.searchParams.get("transport") ||
      (engine === "pandapower" ? "direct" : "mcp");
  if (
    !["pandapower", "pypsa", "andes"].includes(engine) ||
    !["direct", "mcp"].includes(transport) ||
    (transport === "direct" && engine !== "pandapower")
  )
    return NextResponse.json(
      { error: "该执行方式不支持所选任务" },
      { status: 422 },
    );
  const definition = manifest.engines[engine as keyof typeof manifest.engines];
  const checks = await Promise.all([
    checkComponent(engine),
    ...(transport === "mcp" ? [checkComponent("powermcp")] : []),
  ]);
  const ready =
    checks.every((c) => c.status === "available") &&
    checks[0].version === definition.version;
  return NextResponse.json(
    {
      engine,
      transport,
      ready,
      reason: ready
        ? null
        : checks[0].version && checks[0].version !== definition.version
          ? "当前计算版本尚未完成此入口的验收，请联系管理员"
          : "计算环境暂不可用，请联系管理员检查",
      tasks: definition.tasks,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
