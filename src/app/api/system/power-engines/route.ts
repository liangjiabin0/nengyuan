import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/request";
import { checkComponent, POWER_COMPONENTS } from "@/lib/power-compute/health";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const url = new URL(request.url),
    component = url.searchParams.get("component");
  if (!component) return NextResponse.json({ components: POWER_COMPONENTS });
  if (
    !POWER_COMPONENTS.includes(component as (typeof POWER_COMPONENTS)[number])
  )
    return NextResponse.json({ error: "未知组件" }, { status: 422 });
  return NextResponse.json(
    await checkComponent(component, url.searchParams.get("refresh") === "1"),
    { headers: { "cache-control": "private, no-store" } },
  );
}
