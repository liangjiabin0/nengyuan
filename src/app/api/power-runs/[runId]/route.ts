import { publicValue } from "@/lib/power-compute/public-view";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/request";
import { artifactNames, getPowerRun } from "@/lib/power-compute/store";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { runId } = await context.params;
  const run = await getPowerRun(auth.user!.id, runId);
  if (!run)
    return NextResponse.json(
      { error: "运行不存在或无权访问" },
      { status: 404 },
    );
  return NextResponse.json({
    run: publicValue(run),
    artifacts: [
      ...artifactNames(run, auth.user!.role === "admin"),
      ...([
        "succeeded",
        "failed",
        "infeasible",
        "nonconverged",
        "cancelled",
        "timed_out",
      ].includes(run.status)
        ? ["bundle.zip"]
        : []),
    ],
  });
}
