import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import { getJob, updateJobProgress } from "@/lib/jobs/queue";
import type { BackgroundJob } from "@/lib/jobs/types";
import { validateResult, type PowerResult } from "./schema";
import {
  finishPowerRun,
  getPowerRun,
  recordProgress,
  runDirectory,
} from "./store";
import { getPowerModel, modelPath } from "./models";
import { importDirectory } from "./imports";
import { asResultBundle } from "./contracts";
import { powerTimeoutPolicy } from "./timeouts";

function safeEnvironment(directory: string) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of [
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "VIRTUAL_ENV",
    "LD_LIBRARY_PATH",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
    OPENBLAS_NUM_THREADS: "1",
    OMP_NUM_THREADS: "1",
    MPLCONFIGDIR: path.join(directory, "matplotlib"),
    NUMBA_CACHE_DIR: path.join(directory, "numba"),
    ANDES_PYCODE_PATH: path.resolve("storage/power-cache/andes-pycode"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    POWERIO_MCP_ALLOWED_ROOTS: directory,
    POWERMCP_HOME: path.join(directory, "powermcp"),
  };
}
export async function runPowerCompute(job: BackgroundJob) {
  const runId = String(job.payload.runId || ""),
    userId = String(job.payload.userId || "");
  const run = await getPowerRun(userId, runId);
  if (!run) throw new Error("计算任务不存在");
  const token = randomUUID();
  const claimed = await getDb()
    .prepare(
      "UPDATE power_runs SET status='running',lease_token=?,updated_at=? WHERE id=? AND user_id=? AND status='queued'",
    )
    .run(token, new Date().toISOString(), runId, userId);
  if (!claimed.changes) return { runId, skipped: true };
  try {
    const directory = runDirectory(runId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.resolve("storage/power-cache/andes-pycode"), {
      recursive: true,
      mode: 0o700,
    });
    if (run.spec.modelUploadId) {
      const model = await getPowerModel(userId, run.spec.modelUploadId);
      if (!model || model.engine !== run.spec.engine)
        throw new Error("导入模型不存在或无权访问");
      const file = modelPath(model);
      const sourceDir = importDirectory(model.id);
      if (fs.existsSync(sourceDir))
        for (const entry of fs.readdirSync(sourceDir)) {
          if (
            !/^(?:source-[0-9]+\.(?:raw|dyr|m|json|xlsx|nc|csv)|diagnosis\.json|model\.pio\.json)$/.test(
              entry,
            )
          )
            continue;
          const original = path.join(sourceDir, entry);
          if (fs.lstatSync(original).isFile())
            fs.copyFileSync(original, path.join(directory, entry));
        }
      if (fs.realpathSync(file) !== file) throw new Error("模型文件路径无效");
      const data = fs.readFileSync(file);
      if (createHash("sha256").update(data).digest("hex") !== model.sha256)
        throw new Error("模型文件校验失败");
      fs.writeFileSync(
        path.join(
          directory,
          "source" +
            (model.engine === "andes"
              ? ".xlsx"
              : model.engine === "pypsa"
                ? ".nc"
                : ".json"),
        ),
        data,
        { mode: 0o600 },
      );
    }
    fs.writeFileSync(
      path.join(directory, "input.json"),
      JSON.stringify(
        (run.spec as typeof run.spec & { runSpec?: unknown }).runSpec ||
          run.spec,
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const canonical = (run.spec as typeof run.spec & { runSpec?: unknown })
      .runSpec;
    if (canonical)
      fs.writeFileSync(
        path.join(directory, "run-spec.json"),
        JSON.stringify(canonical, null, 2),
        { mode: 0o600 },
      );
    const policy = powerTimeoutPolicy(run.spec.engine);
    const requested = (run.spec.timeLimitSeconds || 0) * 1000;
    if (requested > 0)
      policy.hardLimitMs =
        policy.hardLimitMs > 0
          ? Math.min(policy.hardLimitMs, requested)
          : requested;
    const python =
      process.env.POWER_MCP_PYTHON ||
      path.resolve(
        "tools/power-mcp-venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
    if (!fs.existsSync(python)) {
      await finishPowerRun(
        runId,
        token,
        "failed",
        null,
        "计算环境未安装，请联系管理员安装 PowerMCP 环境",
      );
      return { runId, status: "unavailable" };
    }
    const child = spawn(
      python,
      [
        path.resolve("tools/power-mcp/execute.py"),
        path.join(directory, "input.json"),
        directory,
      ],
      {
        cwd: directory,
        detached: process.platform !== "win32",
        env: safeEnvironment(directory),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const log = fs.createWriteStream(path.join(directory, "solver.log"), {
      flags: "a",
      mode: 0o600,
    });
    if (child.pid)
      fs.writeFileSync(
        path.join(directory, "process.json"),
        JSON.stringify({
          pid: child.pid,
          processGroup: process.platform === "win32" ? null : child.pid,
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    const control: { stopped: "cancelled" | "timed_out" | null } = {
      stopped: null,
    };
    let diagnosticError: string | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve(),
      buffer = "",
      watching = false;
    const terminate = (reason: "cancelled" | "timed_out") => {
      if (control.stopped || !child.pid) return;
      control.stopped = reason;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === "win32")
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              windowsHide: true,
            });
          else process.kill(-child.pid!, signal);
        } catch {
          /* process already exited */
        }
      };
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 3000);
    };
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as {
            phase?: unknown;
            detail?: unknown;
          };
          if (value.phase === "error" && typeof value.detail === "string")
            diagnosticError = value.detail;
          if (
            typeof value.phase === "string" &&
            typeof value.detail === "string"
          )
            pending = pending
              .then(() =>
                recordProgress(
                  runId,
                  token,
                  value.phase as string,
                  value.detail as string,
                ),
              )
              .catch((error) => console.error("[power] progress:", error));
        } catch {
          /* solver output is preserved in log */
        }
      }
      if (buffer.length > 65536) buffer = "";
    });
    child.stderr.on("data", (chunk) => log.write(chunk));
    const startedAt = Date.now();
    const timeout =
      policy.hardLimitMs > 0
        ? setTimeout(() => terminate("timed_out"), policy.hardLimitMs)
        : undefined;
    const reminder =
      policy.reminderMs > 0
        ? setTimeout(() => {
            pending = pending
              .then(async () => {
                const current = await getPowerRun(userId, runId);
                if (
                  current &&
                  ["running", "cancel_requested"].includes(current.status)
                )
                  await recordProgress(
                    runId,
                    token,
                    current.phase,
                    "计算时间较长，后台仍在执行。该提醒不会终止计算，可继续等待或主动取消。",
                  );
              })
              .catch((error) => console.error("[power] reminder:", error));
          }, policy.reminderMs)
        : undefined;
    const watch = setInterval(() => {
      if (watching) return;
      watching = true;
      void Promise.all([getPowerRun(userId, runId), getJob(job.id)])
        .then(([current, currentJob]) => {
          if (
            current?.status === "cancel_requested" ||
            currentJob?.status === "cancelled"
          )
            terminate("cancelled");
          return updateJobProgress(job.id, {
            phase: current?.phase || "running",
            runId,
            elapsedMs: Date.now() - startedAt,
            heartbeatAt: new Date().toISOString(),
          });
        })
        .catch((error) => console.error("[power] heartbeat:", error))
        .finally(() => {
          watching = false;
        });
    }, 1000);
    let exitCode: number | null = null,
      spawnError: Error | null = null;
    try {
      exitCode = await new Promise<number | null>((resolve) => {
        child.once("error", (error) => {
          spawnError = error;
          resolve(null);
        });
        child.once("close", (code) => resolve(code));
      });
    } finally {
      clearInterval(watch);
      clearTimeout(timeout);
      clearTimeout(reminder);
      if (forceTimer) clearTimeout(forceTimer);
      if (control.stopped && child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* owned process group already exited */
        }
      }
      await pending;
      await new Promise<void>((resolve) => log.end(resolve));
    }
    const current = await getPowerRun(userId, runId);
    if (current?.status === "cancel_requested") control.stopped = "cancelled";
    let result: PowerResult | null = null,
      error: string | null = null;
    let status: import("./schema").PowerStatus = control.stopped || "failed";
    if (!control.stopped) {
      try {
        if (exitCode !== 0)
          throw new Error(
            spawnError
              ? String(spawnError)
              : diagnosticError ||
                "计算进程失败，请检查输入诊断或联系管理员查看日志",
          );
        const value: unknown = JSON.parse(
          fs.readFileSync(path.join(directory, "engine-result.json"), "utf8"),
        );
        validateResult(value, run.spec);
        result = value;
        status = [
          "infeasible",
          "diverged",
          "unavailable",
          "solver_error",
          "timed_out",
        ].includes(value.solverStatus)
          ? value.solverStatus === "infeasible"
            ? "infeasible"
            : value.solverStatus === "diverged"
              ? "nonconverged"
              : value.solverStatus === "timed_out"
                ? "timed_out"
                : "failed"
          : "succeeded";
        error =
          status !== "succeeded" ? value.message || value.solverStatus : null;
      } catch (caught) {
        error = String(caught);
      }
    } else
      error =
        control.stopped === "timed_out"
          ? "达到本次任务或管理员设置的计算时限，进程已停止；请调整时限后新建运行"
          : "计算已取消，进程已停止";
    const report = `# 电力计算${status === "succeeded" ? "结果" : "诊断"}\n\n运行：${runId}\n引擎：${run.spec.engine}\n模型：${run.spec.modelId}\n输入哈希：${run.spec.inputHash}\n执行状态：${status}\n求解状态：${result?.solverStatus || "not_completed"}\n判据：${result?.criteriaStatus || "not_evaluated"}\n\n${error || ""}\n\n${JSON.stringify(result?.metrics || {}, null, 2)}\n\n${(result?.warnings || []).join("\n")}\n`;
    if (result) {
      result.bundle = asResultBundle(result, status);
      for (const name of ["result.json", "result-bundle.json"])
        fs.writeFileSync(
          path.join(directory, name),
          JSON.stringify(result.bundle, null, 2),
          { mode: 0o600 },
        );
    }
    await finishPowerRun(runId, token, status, result, error);
    const settled = await getPowerRun(userId, runId);
    const finalReport =
      settled?.status === "cancelled"
        ? `# 电力计算诊断\n\n运行：${runId}\n执行状态：cancelled\n计算已取消，不提供成功结论。\n`
        : report;
    fs.writeFileSync(path.join(directory, "report.md"), finalReport, {
      mode: 0o600,
    });
    return { runId, status: settled?.status || status };
  } catch (error) {
    await finishPowerRun(
      runId,
      token,
      "failed",
      null,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
