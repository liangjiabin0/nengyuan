import { publicText, publicValue } from "@/lib/power-compute/public-view";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/request";
import { getPowerModel } from "@/lib/power-compute/models";
import { z } from "zod";
import {
  powerRequestSchema,
  PowerRunConflictError,
} from "@/lib/power-compute/schema";
import {
  createPowerRun,
  createPowerRuns,
  listPowerRuns,
} from "@/lib/power-compute/store";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const sessionId =
    new URL(request.url).searchParams.get("sessionId") || undefined;
  return NextResponse.json({
    runs: publicValue(await listPowerRuns(auth.user!.id, sessionId)),
  });
}
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const reader = request.body?.getReader();
  let size = 0,
    body = "";
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        body += decoder.decode();
        break;
      }
      size += chunk.value.length;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        return NextResponse.json(
          { error: "计算参数不得超过 2 MB；大型网络请上传原生算例文件" },
          { status: 413 },
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  }
  let value: unknown = null;
  try {
    value = JSON.parse(body);
  } catch {
    /* schema reports invalid input */
  }
  const batch = new URL(request.url).searchParams.get("batch") === "1";
  const parsed = batch
    ? z.array(powerRequestSchema).min(1).max(5).safeParse(value)
    : powerRequestSchema.safeParse(value);
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("；") },
      { status: 422 },
    );
  const requests = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  if (new URL(request.url).searchParams.get("check") === "1") {
    for (const input of requests)
      if (input.modelUploadId) {
        const model = await getPowerModel(auth.user!.id, input.modelUploadId);
        if (!model || model.engine !== input.engine)
          return NextResponse.json(
            { error: "模型不存在或无权访问" },
            { status: 404 },
          );
        if (
          model.diagnosis_json &&
          !JSON.parse(model.diagnosis_json).allowedAnalyses?.includes(
            input.parameters.analysis,
          )
        )
          return NextResponse.json(
            { error: "模型不支持当前分析，请检查算例诊断" },
            { status: 422 },
          );
      }
    return NextResponse.json({ valid: true });
  }
  try {
    if (batch) {
      const values = await createPowerRuns(auth.user!.id, requests);
      return NextResponse.json(
        publicValue({ runs: values.map((value) => value.run) }),
        { status: values.some((value) => value.created) ? 202 : 200 },
      );
    }
    const value = await createPowerRun(auth.user!.id, requests[0]);
    return NextResponse.json(publicValue(value), {
      status: value.created ? 202 : 200,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建计算任务失败";
    return NextResponse.json(
      { error: publicText(message) },
      {
        status:
          error instanceof PowerRunConflictError
            ? 409
            : /无权|不属于|不存在/.test(message)
              ? 404
              : /最多/.test(message)
                ? 429
                : /模型不支持|参数|算例/.test(message)
                  ? 422
                  : /请求编号|必须/.test(message)
                    ? 409
                    : 500,
      },
    );
  }
}
