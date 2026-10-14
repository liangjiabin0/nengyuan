import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderLatexSvg } from "./render_latex_svg.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const manifestArgument = process.argv[2];
if (!manifestArgument) throw new Error("Usage: node apply_formula_manifest.mjs <formula-manifest.json>");
const manifestPath = path.resolve(manifestArgument);
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (!path.isAbsolute(manifest.sourcePptx ?? "") || !path.isAbsolute(manifest.outputPptx ?? "")) {
  throw new Error("sourcePptx and outputPptx must be absolute paths");
}
if (!Array.isArray(manifest.formulas) || manifest.formulas.length === 0) throw new Error("formulas must be non-empty");

const workDir = path.join(path.dirname(manifestPath), ".formula-build");
const cacheDir = path.join(workDir, "mathjax");
const svgDir = path.join(workDir, "svg");
await fs.mkdir(svgDir, { recursive: true });
for (const formula of manifest.formulas) {
  for (const key of ["id", "latex", "targetShapeName", "position"]) {
    if (!formula[key]) throw new Error(`formula is missing ${key}`);
  }
  if (!Number.isInteger(formula.slide) || formula.slide < 1) throw new Error(`invalid slide for ${formula.id}`);
  const svg = await renderLatexSvg({ latex: formula.latex, color: formula.color, cacheDir });
  const withMetadata = svg.replace(/(<svg\b[^>]*>)/i, `$1<metadata>${escapeXml(JSON.stringify({ id: formula.id, latex: formula.latex }))}</metadata>`);
  formula.svgPath = path.join(svgDir, `${safeName(formula.id)}.svg`);
  formula.placedPosition = containInBox(withMetadata, formula.position);
  await fs.writeFile(formula.svgPath, withMetadata, "utf8");
}

const runtimeManifest = path.join(workDir, "runtime-manifest.json");
await fs.writeFile(runtimeManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const outputPath = await nextAvailablePath(path.resolve(manifest.outputPptx));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await run("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptDir, "replace_formula_shapes.ps1"),
  "-SourcePptx", path.resolve(manifest.sourcePptx), "-OutputPptx", outputPath, "-ManifestJson", runtimeManifest,
]);
console.log(`FORMULA_APPLY_RESULT=${JSON.stringify({ outputPath, svgDir })}`);

function containInBox(svg, box) {
  const viewBox = svg.match(/viewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return box;
  const aspect = viewBox[2] / viewBox[3];
  const boxAspect = box.width / box.height;
  let width, height;
  if (aspect > boxAspect) { width = box.width; height = width / aspect; }
  else { height = box.height; width = height * aspect; }
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}
function safeName(value) { return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-"); }
function escapeXml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
async function nextAvailablePath(desired) {
  try {
    await fs.access(desired);
    const parsed = path.parse(desired);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext}`);
  } catch { return desired; }
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}\n${stderr}\n${stdout}`)));
  });
}
