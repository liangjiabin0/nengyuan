import fs from "node:fs";
import path from "node:path";
export function publicText(value: string) {
  return value
    .replace(/\/(?:data|home|usr|tmp|var|opt)\/[^\s"'<>;,]+/g, "[内部路径]")
    .replace(/[A-Za-z]:[\\/][^\s"'<>;,]+/g, "[内部路径]")
    .replace(
      /((?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[已隐藏]",
    );
}
export function publicValue<T>(value: T): T {
  if (typeof value === "string") return publicText(value) as T;
  if (Array.isArray(value)) return value.map(publicValue) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[_-]?key|password|secret|access[_-]?token)$/i.test(key)
          ? "[已隐藏]"
          : publicValue(item),
      ]),
    ) as T;
  return value;
}
export function artifactData(filename: string) {
  const data = fs.readFileSync(filename);
  if (
    /^source-[0-9]+\./.test(path.basename(filename)) ||
    filename.endsWith(".csv")
  )
    return data;
  if (filename.endsWith(".json")) {
    try {
      const parsed = JSON.parse(data.toString("utf8"));
      const safe = publicValue(parsed);
      return JSON.stringify(parsed) === JSON.stringify(safe)
        ? data
        : Buffer.from(JSON.stringify(safe, null, 2));
    } catch {
      return Buffer.from(publicText(data.toString("utf8")));
    }
  }
  if (/\.(?:log|md|csv)$/.test(filename))
    return Buffer.from(publicText(data.toString("utf8")));
  return data;
}
