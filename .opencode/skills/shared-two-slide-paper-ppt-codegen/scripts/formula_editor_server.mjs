import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderLatexSvg } from "./render_latex_svg.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(scriptDir);
const assetsDir = path.join(skillDir, "assets", "formula-editor");
const manifestArgument = process.env.FORMULA_MANIFEST;
if (!manifestArgument || !path.isAbsolute(manifestArgument)) {
  throw new Error("Set FORMULA_MANIFEST to an absolute formula-manifest.json path");
}
const manifestPath = path.resolve(manifestArgument);
const cacheDir = path.join(path.dirname(manifestPath), ".formula-editor-cache");
const port = Number(process.env.FORMULA_EDITOR_PORT || 4317);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/formulas") return json(res, 200, JSON.parse(await fs.readFile(manifestPath, "utf8")));
    if (req.method === "POST" && url.pathname === "/api/preview") {
      const body = await readJson(req);
      const svg = await renderLatexSvg({ latex: body.latex, color: body.color, cacheDir });
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(svg);
    }
    if (req.method === "POST" && url.pathname === "/api/build") {
      const body = await readJson(req);
      await fs.writeFile(manifestPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      const run = await runChild(process.execPath, [path.join(scriptDir, "apply_formula_manifest.mjs"), manifestPath]);
      const match = run.stdout.match(/FORMULA_APPLY_RESULT=(\{.*\})/);
      return json(res, 200, { ok: true, ...(match ? JSON.parse(match[1]) : { log: run.stdout }) });
    }
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(assetsDir, relative);
    const relativeToAssets = path.relative(assetsDir, filePath);
    if (relativeToAssets.startsWith("..") || path.isAbsolute(relativeToAssets)) return json(res, 403, { error: "Forbidden" });
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" }); res.end(data);
  } catch (error) { json(res, 500, { ok: false, error: error.stack || error.message }); }
});
server.listen(port, "127.0.0.1", () => console.log(`Formula editor: http://127.0.0.1:${port}`));

function readJson(req) { return new Promise((resolve, reject) => { let body = ""; req.setEncoding("utf8"); req.on("data", c => { body += c; }); req.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } }); req.on("error", reject); }); }
function json(res, status, value) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
function runChild(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; }); child.on("error", reject); child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Formula build failed (${code})\n${stderr}\n${stdout}`))); }); }
