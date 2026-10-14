import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MATHJAX_VERSION = "3.2.2";
const MATHJAX_URL = `https://cdn.jsdelivr.net/npm/mathjax@${MATHJAX_VERSION}/es5/tex-svg.js`;

export async function renderLatexSvg({ latex, color = "#123E78", cacheDir, browserExecutable }) {
  if (!latex || !path.isAbsolute(cacheDir ?? "")) throw new Error("latex and absolute cacheDir are required");
  await fs.mkdir(cacheDir, { recursive: true });
  const bundlePath = await resolveMathJaxBundle(cacheDir);
  const htmlPath = path.join(cacheDir, "mathjax-render.html");
  await fs.writeFile(htmlPath, renderHostHtml(path.basename(bundlePath)), "utf8");
  const browser = browserExecutable || process.env.BROWSER_EXECUTABLE || await findBrowser();
  const renderUrl = new URL(pathToFileURL(htmlPath).href);
  renderUrl.searchParams.set("tex", latex);
  renderUrl.searchParams.set("color", color);
  const profileDir = path.join(cacheDir, "edge-profile");
  await fs.mkdir(profileDir, { recursive: true });
  const { stdout } = await run(browser, [
    "--headless=new", "--disable-gpu", "--allow-file-access-from-files",
    `--user-data-dir=${profileDir}`, "--virtual-time-budget=5000", "--dump-dom", renderUrl.href,
  ]);
  const match = stdout.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) throw new Error(`MathJax did not return SVG.\n${stdout.slice(0, 1200)}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${match[0]}`;
}

async function resolveMathJaxBundle(cacheDir) {
  const explicit = process.env.MATHJAX_SVG_BUNDLE;
  if (explicit) {
    const resolved = path.resolve(explicit);
    await fs.access(resolved);
    const local = path.join(cacheDir, "tex-svg.js");
    if (resolved !== local) await fs.copyFile(resolved, local);
    return local;
  }
  const target = path.join(cacheDir, "tex-svg.js");
  try { await fs.access(target); return target; } catch {}
  const response = await fetch(MATHJAX_URL);
  if (!response.ok) throw new Error(`Unable to download pinned MathJax ${MATHJAX_VERSION}: ${response.status}`);
  await fs.writeFile(target, new Uint8Array(await response.arrayBuffer()));
  return target;
}

async function findBrowser() {
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error("Edge/Chrome not found; set BROWSER_EXECUTABLE to an absolute path");
}

function renderHostHtml(bundleName) {
  return `<!doctype html><html><head><meta charset="utf-8"><script>
window.MathJax={loader:{load:['input/tex','output/svg']},tex:{packages:{'[+]':['ams']}},svg:{fontCache:'none'},startup:{typeset:false}};
</script><script src="./${bundleName}"></script></head><body><div>rendering</div><script>
(async()=>{const p=new URLSearchParams(location.search);const color=p.get('color')||'#123E78';await MathJax.startup.promise;const n=await MathJax.tex2svgPromise(p.get('tex')||'x',{display:true});const svg=n.querySelector('svg');svg.setAttribute('xmlns','http://www.w3.org/2000/svg');svg.setAttribute('preserveAspectRatio','xMidYMid meet');svg.setAttribute('style','color:'+color+';background:transparent');svg.querySelectorAll('[fill="currentColor"]').forEach(e=>e.setAttribute('fill',color));svg.querySelectorAll('[stroke="currentColor"]').forEach(e=>e.setAttribute('stroke',color));document.body.replaceChildren(svg);document.documentElement.dataset.ready='1'})().catch(e=>{document.body.textContent='FORMULA_RENDER_ERROR: '+(e.stack||e.message)})
</script></body></html>`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}\n${stderr}`)));
  });
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) result[argv[i]?.replace(/^--/, "")] = argv[i + 1];
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.latex || !args.output || !args["cache-dir"]) {
    throw new Error("Usage: node render_latex_svg.mjs --latex <tex> --output <svg> --cache-dir <absolute-dir> [--color #123E78]");
  }
  const svg = await renderLatexSvg({ latex: args.latex, color: args.color, cacheDir: path.resolve(args["cache-dir"]) });
  await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
  await fs.writeFile(path.resolve(args.output), svg, "utf8");
  console.log(path.resolve(args.output));
}
