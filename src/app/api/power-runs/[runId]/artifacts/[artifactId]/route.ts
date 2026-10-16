import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { artifactData } from "@/lib/power-compute/public-view";
import { createHash } from "node:crypto";
import { requireUser } from "@/lib/auth/request";
import {
  artifactNames,
  getPowerRun,
  runDirectory,
} from "@/lib/power-compute/store";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; artifactId: string }> },
) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { runId, artifactId } = await context.params;
  const run = await getPowerRun(auth.user!.id, runId);
  if (!run)
    return NextResponse.json(
      { error: "文件不存在或无权访问" },
      { status: 404 },
    );
  if (
    artifactId === "bundle.zip" &&
    [
      "succeeded",
      "failed",
      "infeasible",
      "nonconverged",
      "cancelled",
      "timed_out",
    ].includes(run.status)
  ) {
    const zip = new JSZip();
    const manifest: Record<string, string> = {};
    let total = 0;
    for (const name of artifactNames(run, auth.user!.role === "admin")) {
      const filename = path.join(runDirectory(runId), name);
      total += fs.statSync(filename).size;
      const data =
        total <= 100 * 1024 * 1024 ? artifactData(filename) : Buffer.alloc(0);
      if (total > 100 * 1024 * 1024)
        return NextResponse.json(
          { error: "产物总量超过打包上限，请逐项下载" },
          { status: 413 },
        );
      manifest[name] = createHash("sha256").update(data).digest("hex");
      zip.file(name, data);
    }
    zip.file(
      "manifest.json",
      JSON.stringify(
        { runId, inputHash: run.spec.inputHash, files: manifest },
        null,
        2,
      ),
    );
    const archive = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
    return new Response(new Uint8Array(archive).buffer, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="power-${runId}.zip"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (!artifactNames(run, auth.user!.role === "admin").includes(artifactId))
    return NextResponse.json(
      { error: "文件不存在或无权访问" },
      { status: 404 },
    );
  const file = path.join(runDirectory(runId), artifactId);
  const media = artifactId.endsWith(".json")
    ? "application/json"
    : artifactId.endsWith(".csv")
      ? "text/csv; charset=utf-8"
      : artifactId.endsWith(".md") || artifactId.endsWith(".log")
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
  const body = artifactId.endsWith(".csv")
    ? (Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>)
    : artifactData(file);
  return new Response(body, {
    headers: {
      "content-type": media,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifactId)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
