import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/request";
import { getPowerRun, runDirectory } from "@/lib/power-compute/store";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; tableId: string }> },
) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { runId, tableId } = await context.params;
  const run = await getPowerRun(auth.user!.id, runId);
  if (
    !run?.result ||
    !/^[a-z-]+$/.test(tableId) ||
    !Object.hasOwn(run.result.tables, tableId)
  )
    return NextResponse.json(
      { error: "表格不存在或无权访问" },
      { status: 404 },
    );
  const url = new URL(request.url),
    page = Number(url.searchParams.get("page") || 0),
    size = Number(url.searchParams.get("size") || 25);
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    page > 1000000 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 200
  )
    return NextResponse.json({ error: "分页参数无效" }, { status: 422 });
  const filename = path.join(runDirectory(runId), tableId + ".csv");
  if (!fs.existsSync(filename) || !fs.lstatSync(filename).isFile())
    return NextResponse.json({ error: "表格文件尚未生成" }, { status: 404 });
  const stream = fs.createReadStream(filename),
    parser = stream.pipe(
      parse({ columns: true, bom: true, max_record_size: 1048576 }),
    );
  stream.once("error", (error) => parser.destroy(error));
  const rows: Array<Record<string, string>> = [];
  let index = 0;
  try {
    for await (const row of parser) {
      if (index >= page * size) rows.push(row);
      index++;
      if (rows.length >= size) break;
    }
  } catch {
    return NextResponse.json(
      { error: "表格读取失败，请下载原始产物或联系管理员" },
      { status: 500 },
    );
  } finally {
    parser.destroy();
    stream.destroy();
  }
  return NextResponse.json(
    {
      rows,
      total:
        run.result.tableCounts?.[tableId] ?? run.result.tables[tableId].length,
      page,
      size,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
