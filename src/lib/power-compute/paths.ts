import fs from "node:fs";
import path from "node:path";

/** Resolve the shared storage mount once, while rejecting redirected child roots. */
export function powerStorageDirectory(
  name: "power-runs" | "power-imports" | "power-models",
) {
  const storage = path.resolve("storage");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  const directory = path.join(fs.realpathSync(storage), name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory)
    throw new Error("计算存储目录存在非法链接");
  return directory;
}
