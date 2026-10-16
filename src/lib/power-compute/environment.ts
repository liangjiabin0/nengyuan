import path from "node:path";
export function powerPython() {
  return (
    process.env.POWER_MCP_PYTHON ||
    path.resolve(
      "tools/power-mcp-venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    )
  );
}
export function diagnosticEnvironment(directory: string) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "LANG", "LD_LIBRARY_PATH"])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    OPENBLAS_NUM_THREADS: "1",
    OMP_NUM_THREADS: "1",
    MPLCONFIGDIR: path.join(directory, "matplotlib"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    POWERIO_MCP_ALLOWED_ROOTS: directory,
  };
}
