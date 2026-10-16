import { publicText } from "@/lib/power-compute/public-view";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/request";
import { listPowerModels, storePowerModel } from "@/lib/power-compute/models";
import { groupModelFiles } from "@/lib/power-compute/model-files";
import type { EngineId } from "@/lib/power-compute/catalog";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  if (new URL(request.url).searchParams.get("template") === "csv") {
    const rows = [
      [
        "component",
        "id",
        "bus",
        "base_mva",
        "voltage_kv",
        "from_bus",
        "to_bus",
        "length_km",
        "r_ohm_per_km",
        "x_ohm_per_km",
        "c_nf_per_km",
        "max_i_ka",
        "p_mw",
        "q_mvar",
      ],
      ["network", "", "bus1", "100"],
      ["bus", "bus1", "", "", "110"],
      ["bus", "bus2", "", "", "110"],
      [
        "line",
        "line1",
        "",
        "",
        "",
        "bus1",
        "bus2",
        "10",
        "0.1",
        "0.4",
        "10",
        "1",
      ],
      ["load", "", "bus2", "", "", "", "", "", "", "", "", "", "10", "2"],
    ];
    return new Response(
      "\ufeff" +
        rows
          .map((row) =>
            Array.from({ length: 14 }, (_, i) => row[i] || "").join(","),
          )
          .join("\n"),
      {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="network-template.csv"',
        },
      },
    );
  }
  if (new URL(request.url).searchParams.get("template") === "static")
    return NextResponse.json(
      {
        schemaVersion: "static-network/v1",
        baseMva: 100,
        slackBus: "bus1",
        buses: [
          { id: "bus1", voltageKv: 110 },
          { id: "bus2", voltageKv: 110 },
        ],
        lines: [
          {
            id: "line1",
            from: "bus1",
            to: "bus2",
            lengthKm: 10,
            rOhmPerKm: 0.1,
            xOhmPerKm: 0.4,
            cNfPerKm: 10,
            maxCurrentKa: 1,
          },
        ],
        loads: [{ bus: "bus2", pMw: 10, qMvar: 2 }],
      },
      {
        headers: {
          "content-disposition":
            'attachment; filename="static-network-template.json"',
        },
      },
    );
  return NextResponse.json({ models: await listPowerModels(auth.user!.id) });
}
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const stream = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (stream)
      while (true) {
        const item = await stream.read();
        if (item.done) break;
        total += item.value.length;
        if (total > 10 * 1024 * 1024 + 65536) {
          await stream.cancel();
          return NextResponse.json(
            { error: "上传总量超过限制" },
            { status: 413 },
          );
        }
        chunks.push(item.value);
      }
    let form: FormData;
    try {
      form = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": request.headers.get("content-type")! },
      }).formData();
    } catch {
      return NextResponse.json({ error: "上传格式无效" }, { status: 422 });
    }
    const selected = [...form.getAll("file"), ...form.getAll("dynamicFile")];
    const engine = new URL(request.url).searchParams.get("engine") || "";
    if (
      !selected.length ||
      selected.some(
        (file) =>
          !(file instanceof File) || !file.size || file.size > 5 * 1024 * 1024,
      )
    )
      return NextResponse.json(
        { error: "算例文件须非空且每个不超过 5 MB" },
        { status: 413 },
      );
    try {
      if (!["andes", "pypsa", "pandapower"].includes(engine))
        throw new Error("计算类型无效");
      const groups = groupModelFiles(engine as EngineId, selected as File[]);
      if (groups.length !== 1)
        throw new Error("单次导入只能包含一个算例；批量上传请逐算例导入");
      const { primary, dynamic: paired } = groups[0];
      const model = await storePowerModel(
        auth.user!.id,
        engine,
        primary.name,
        Buffer.from(await primary.arrayBuffer()),
        paired instanceof File
          ? {
              name: paired.name,
              bytes: Buffer.from(await paired.arrayBuffer()),
            }
          : undefined,
        request.signal,
      );
      return NextResponse.json({ model }, { status: 201 });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? publicText(e.message) : "算例检查失败" },
        { status: 422 },
      );
    }
  }
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "模型为空" }, { status: 422 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 5 * 1024 * 1024) {
      await reader.cancel();
      return NextResponse.json({ error: "模型不得超过 5 MB" }, { status: 413 });
    }
    chunks.push(item.value);
  }
  try {
    const model = await storePowerModel(
      auth.user!.id,
      new URL(request.url).searchParams.get("engine") || "",
      decodeURIComponent(request.headers.get("x-model-filename") || ""),
      Buffer.concat(chunks),
      undefined,
      request.signal,
    );
    return NextResponse.json({ model }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? publicText(error.message) : "模型导入失败",
      },
      { status: 422 },
    );
  }
}
