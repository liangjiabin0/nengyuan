import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import JSZip from "jszip";
import {
  diagnoseImport,
  importDirectory,
  type ImportDiagnosis,
} from "./imports";
import { ensureDb, getDb } from "@/lib/db";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const positive = z.number().finite().positive();
export const staticNetworkSchema = z
  .object({
    schemaVersion: z.literal("static-network/v1"),
    baseMva: positive.max(10000),
    slackBus: id,
    buses: z
      .array(z.object({ id, voltageKv: positive.max(1000) }).strict())
      .min(2)
      .max(500),
    lines: z
      .array(
        z
          .object({
            id,
            from: id,
            to: id,
            lengthKm: positive.max(10000),
            rOhmPerKm: z.number().finite().min(0).max(100),
            xOhmPerKm: positive.max(100),
            cNfPerKm: z.number().finite().min(0).max(100000),
            maxCurrentKa: positive.max(100),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    loads: z
      .array(
        z
          .object({
            bus: id,
            pMw: z.number().finite().min(0).max(100000),
            qMvar: z.number().finite().min(-100000).max(100000),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
  .superRefine((network, ctx) => {
    const buses = new Set(network.buses.map((bus) => bus.id));
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (buses.size !== network.buses.length || !buses.has(network.slackBus))
      issue("母线 ID 重复或平衡母线缺失");
    if (
      new Set(network.lines.map((line) => line.id)).size !==
      network.lines.length
    )
      issue("线路 ID 重复");
    for (const line of network.lines) {
      if (!buses.has(line.from) || !buses.has(line.to) || line.from === line.to)
        issue("线路端点无效");
      if (
        network.buses.find((bus) => bus.id === line.from)?.voltageKv !==
        network.buses.find((bus) => bus.id === line.to)?.voltageKv
      )
        issue("线路两端电压等级须一致；本导入格式不自动补造变压器");
    }
    for (const load of network.loads)
      if (!buses.has(load.bus)) issue("负荷引用未知母线");
    const seen = new Set([network.slackBus]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const line of network.lines)
        if (seen.has(line.from) !== seen.has(line.to)) {
          seen.add(line.from);
          seen.add(line.to);
          changed = true;
        }
    }
    if (seen.size !== buses.size)
      issue("当前潮流导入仅支持连通网络，请检查孤岛");
  });
type ModelRow = {
  id: string;
  user_id: string;
  engine: string;
  filename: string;
  sha256: string;
  created_at: string;
  diagnosis_json: string | null;
};
let ready: Promise<void> | null = null;
export function ensureModelTable() {
  return (ready ??= (async () => {
    await ensureDb();
    await getDb().exec(`CREATE TABLE IF NOT EXISTS power_models (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),engine TEXT NOT NULL,filename TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
    ALTER TABLE power_models ADD COLUMN IF NOT EXISTS diagnosis_json TEXT;
    CREATE INDEX IF NOT EXISTS power_models_owner ON power_models(user_id,created_at);`);
  })().catch((error) => {
    ready = null;
    throw error;
  }));
}
export function modelPath(model: Pick<ModelRow, "id" | "engine">) {
  if (!z.string().uuid().safeParse(model.id).success)
    throw new Error("无效模型编号");
  const base = path.resolve("storage/power-models");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return path.join(
    base,
    model.id +
      (model.engine === "andes"
        ? ".xlsx"
        : model.engine === "pypsa"
          ? ".nc"
          : ".json"),
  );
}
export async function getPowerModel(userId: string, id: string) {
  await ensureModelTable();
  return getDb()
    .prepare("SELECT * FROM power_models WHERE id=? AND user_id=?")
    .get<ModelRow>(id, userId);
}
export async function listPowerModels(userId: string) {
  await ensureModelTable();
  return getDb()
    .prepare(
      "SELECT id,engine,filename,sha256,created_at,diagnosis_json FROM power_models WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
    )
    .all<ModelRow>(userId);
}
async function validateWorkbook(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  const files = Object.values(zip.files);
  if (
    files.length > 200 ||
    !zip.file("xl/workbook.xml") ||
    zip.file("xl/vbaProject.bin")
  )
    throw new Error("无效的动态模型文件");
  for (const entry of files) {
    if (entry.dir) continue;
    // JSZip exposes the central-directory uncompressed size; reject before inflation.
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })
      ._data?.uncompressedSize;
    if (size === undefined || size > 20 * 1024 * 1024)
      throw new Error("模型压缩条目超过限制");
    total += size;
    if (
      total > 30 * 1024 * 1024 ||
      /(?:vbaProject|externalLinks)/i.test(entry.name)
    )
      throw new Error("模型包含超限数据或外部引用");
  }
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  return workbook;
}
export async function storePowerModel(
  userId: string,
  engine: string,
  filename: string,
  bytes: Buffer,
  paired?: { name: string; bytes: Buffer },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await ensureModelTable();
  const count = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM power_models WHERE user_id=?")
    .get<{ n: number }>(userId);
  if (Number(count?.n) >= 100)
    throw new Error("模型数量达到 100 个，请联系管理员归档");
  const modelId = randomUUID();
  try {
    return await storeModelInput(
      modelId,
      userId,
      engine,
      filename,
      bytes,
      paired,
      signal,
    );
  } catch (error) {
    // Only this newly allocated import directory is eligible for cleanup.
    const directory = importDirectory(modelId);
    if (path.dirname(directory) !== path.resolve("storage/power-imports"))
      throw new Error("导入临时目录范围无效");
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function storeModelInput(
  modelId: string,
  userId: string,
  engine: string,
  filename: string,
  bytes: Buffer,
  paired?: { name: string; bytes: Buffer },
  signal?: AbortSignal,
) {
  const originalBytes = bytes;
  let diagnosis: ImportDiagnosis | null = null;
  if (!["pandapower", "andes", "pypsa"].includes(engine))
    throw new Error("该引擎请使用结构化时序参数");
  if (bytes.length > 5 * 1024 * 1024 || !bytes.length)
    throw new Error("模型须为非空文件且不超过 5 MB");
  if (engine === "pandapower" && filename.toLowerCase().endsWith(".xlsx"))
    await validateWorkbook(bytes);
  const customStatic =
    engine === "pandapower" &&
    filename.toLowerCase().endsWith(".json") &&
    (() => {
      try {
        return (
          JSON.parse(bytes.toString("utf8")).schemaVersion ===
          "static-network/v1"
        );
      } catch {
        return false;
      }
    })();
  if (
    !customStatic &&
    !(engine === "andes" && filename.toLowerCase().endsWith(".xlsx"))
  ) {
    const imported = await diagnoseImport(
      modelId,
      engine,
      [{ name: filename, bytes }, ...(paired ? [paired] : [])],
      signal,
    );
    bytes = imported.bytes;
    diagnosis = imported.diagnosis;
    if (engine === "pandapower" && diagnosis.loader === "table-template")
      bytes = Buffer.from(
        JSON.stringify(
          staticNetworkSchema.parse(JSON.parse(bytes.toString("utf8"))),
        ),
      );
  } else if (engine === "pandapower") {
    if (!filename.toLowerCase().endsWith(".json"))
      throw new Error("静态网络需上传 static-network/v1 JSON");
    const parsed = staticNetworkSchema.safeParse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (!parsed.success)
      throw new Error(
        parsed.error.issues.map((item) => item.message).join("；"),
      );
    bytes = Buffer.from(JSON.stringify(parsed.data));
    const directory = importDirectory(modelId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "source-0.json"), originalBytes, {
      mode: 0o600,
    });
    diagnosis = {
      format: "static-network/v1",
      loader: "validated-template",
      counts: {
        buses: parsed.data.buses.length,
        lines: parsed.data.lines.length,
        transformers: 0,
        generators: 1,
        loads: parsed.data.loads.length,
        dynamicModels: 0,
      },
      baseMva: parsed.data.baseMva,
      units: "MW / Mvar / kV / p.u.",
      source: "user",
      originals: [
        {
          name: filename,
          sha256: createHash("sha256").update(originalBytes).digest("hex"),
        },
      ],
      diagnostics: [
        {
          severity: "warning",
          message:
            "本模板仅支持线路、负荷与平衡电源；不自动补造变压器或动态模型。",
        },
      ],
      normalizedHash: createHash("sha256").update(bytes).digest("hex"),
      allowedAnalyses: ["ac_flow", "dc_flow", "n_minus_1", "n_minus_2"],
    };
    fs.writeFileSync(
      path.join(directory, "diagnosis.json"),
      JSON.stringify(diagnosis),
      { mode: 0o600 },
    );
  } else {
    if (!filename.toLowerCase().endsWith(".xlsx"))
      throw new Error("动态模型需上传 ANDES XLSX（不接受静态网络或宏）");
    const workbook = await validateWorkbook(bytes);
    if (
      !/name="Bus"/.test(workbook) ||
      !/name="(?:GENROU|GENCLS|GENSAL)"/.test(workbook)
    )
      throw new Error("缺少 Bus 与同步机动态参数，不能用静态网络运行 TDS");
  }
  if (engine === "andes" && !diagnosis) {
    const imported = await diagnoseImport(
      modelId,
      engine,
      [{ name: filename, bytes: originalBytes }],
      signal,
    );
    bytes = imported.bytes;
    diagnosis = imported.diagnosis;
  }
  signal?.throwIfAborted();
  const model = {
    id: modelId,
    user_id: userId,
    engine,
    filename: filename.replace(/[\r\n\/\\]/g, "_").slice(0, 100),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    created_at: new Date().toISOString(),
    diagnosis_json: JSON.stringify(diagnosis),
  };
  const file = modelPath(model);
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  try {
    await getDb()
      .prepare(
        "INSERT INTO power_models(id,user_id,engine,filename,sha256,created_at,diagnosis_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        model.id,
        userId,
        engine,
        model.filename,
        model.sha256,
        model.created_at,
        model.diagnosis_json,
      );
  } catch (error) {
    fs.unlinkSync(file);
    throw error;
  }
  return model;
}
