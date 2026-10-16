import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { publicValue } from "./public-view";
import { powerPython, diagnosticEnvironment } from "./environment";
export type ImportDiagnosis = {
  format: string;
  loader: string;
  loaderVersion?: string;
  counts: Record<string, number>;
  baseMva: number | null;
  units: string;
  source: "user";
  originals: Array<{ name: string; sha256: string }>;
  diagnostics: Array<{ severity?: string; code?: string; message?: string }>;
  normalizedHash: string;
  allowedAnalyses: string[];
};
export function importDirectory(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("无效模型编号");
  const directory = path.resolve("storage/power-imports", id);
  if (fs.existsSync(directory) && fs.realpathSync(directory) !== directory)
    throw new Error("模型目录无效");
  return directory;
}
export async function diagnoseImport(
  id: string,
  engine: string,
  files: Array<{ name: string; bytes: Buffer }>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const directory = importDirectory(id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifest: Record<string, string> = {};
  for (const [index, file] of files.entries()) {
    const extension = path.extname(file.name).toLowerCase();
    if (
      ![".m", ".raw", ".dyr", ".json", ".xlsx", ".csv", ".nc"].includes(
        extension,
      )
    )
      throw new Error("未验证的算例格式，请使用支持的格式或模板");
    const name = `source-${index}${extension}`;
    manifest[name] = file.name.replace(/[\/\\\r\n]/g, "_").slice(0, 100);
    fs.writeFileSync(path.join(directory, name), file.bytes, { mode: 0o600 });
  }
  fs.writeFileSync(
    path.join(directory, "sources.json"),
    JSON.stringify(manifest),
    { mode: 0o600 },
  );
  await new Promise<void>((resolve, reject) =>
    execFile(
      powerPython(),
      [path.resolve("tools/power-mcp/diagnose.py"), directory, engine],
      {
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
        env: diagnosticEnvironment(directory),
      },
      (error, stdout, stderr) => {
        fs.writeFileSync(path.join(directory, "import.log"), stderr, {
          mode: 0o600,
        });
        if (error) {
          if (error.name === "AbortError") {
            reject(new Error("已取消模型导入"));
            return;
          }
          let message = "算例检查失败，请核对格式与必要模型";
          try {
            message =
              JSON.parse(stdout.trim().split("\n").at(-1) || "{}").error ||
              message;
          } catch {}
          reject(
            new Error(
              message.replace(
                /(?:\/(?:data|home|usr|tmp)\/)[^\s;,]+/g,
                "[内部路径]",
              ),
            ),
          );
        } else resolve();
      },
    ),
  );
  return {
    bytes: fs.readFileSync(
      path.join(
        directory,
        engine === "andes"
          ? "normalized.xlsx"
          : engine === "pypsa"
            ? "normalized.nc"
            : "normalized.json",
      ),
    ),
    diagnosis: publicValue(
      JSON.parse(
        fs.readFileSync(path.join(directory, "diagnosis.json"), "utf8"),
      ),
    ) as ImportDiagnosis,
  };
}
