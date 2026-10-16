import type { EngineId } from "./catalog";

export const MAX_IMPORT_FILES = 10;
export const MAX_IMPORT_CASES = 5;
export const MAX_MODEL_FILE_BYTES = 5 * 1024 * 1024;
type InputFile = { name: string; size: number };
export type ModelFileGroup<T extends InputFile> = { primary: T; dynamic?: T };
const extension = (name: string) =>
  name.toLowerCase().slice(name.lastIndexOf("."));
const stem = (name: string) => name.toLowerCase().replace(/\.[^.]+$/, "");

export function groupModelFiles<T extends InputFile>(
  engine: EngineId,
  files: T[],
): ModelFileGroup<T>[] {
  if (!files.length || files.length > MAX_IMPORT_FILES)
    throw new Error(`每批请选择 1—${MAX_IMPORT_FILES} 个文件`);
  if (files.some((f) => !f.size || f.size > MAX_MODEL_FILE_BYTES))
    throw new Error("每个文件须非空且不超过 5 MB");
  if (new Set(files.map((f) => f.name.toLowerCase())).size !== files.length)
    throw new Error("本批存在同名文件，请重命名后再选择，避免算例配错");
  const allowed =
    engine === "andes"
      ? [".xlsx", ".raw", ".dyr"]
      : engine === "pypsa"
        ? [".nc"]
        : [".m", ".raw", ".json", ".csv", ".xlsx"];
  if (files.some((f) => !allowed.includes(extension(f.name))))
    throw new Error("所选文件格式不适用于当前分析类型");
  let groups: ModelFileGroup<T>[];
  if (engine !== "andes") groups = files.map((primary) => ({ primary }));
  else {
    const raw = files.filter((f) => extension(f.name) === ".raw");
    const dyr = files.filter((f) => extension(f.name) === ".dyr");
    if (raw.length !== dyr.length)
      throw new Error(
        "每个 RAW 需要一个配套 DYR，请成对选择；也可直接选择完整 ANDES XLSX",
      );
    groups = files
      .filter((f) => extension(f.name) === ".xlsx")
      .map((primary) => ({ primary }));
    for (const primary of raw) {
      const dynamic =
        raw.length === 1
          ? dyr[0]
          : dyr.find((f) => stem(f.name) === stem(primary.name));
      if (!dynamic)
        throw new Error(
          "多组 RAW/DYR 需使用相同文件主名配对；名称不一致时请每次单独上传一对",
        );
      groups.push({ primary, dynamic });
    }
  }
  if (groups.length > MAX_IMPORT_CASES)
    throw new Error(
      `每批最多 ${MAX_IMPORT_CASES} 个独立算例；RAW＋DYR 两个文件算一个算例`,
    );
  return groups;
}
