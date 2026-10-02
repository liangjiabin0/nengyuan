#!/usr/bin/env node
// Build a visual index for the pinned SVG allowlist using the bundled Sharp runtime.

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../assets/electrical-icons");
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const output = path.resolve(process.argv[2] || path.join(root, "icon-contact-sheet.png"));
const columns = 8;
const cellWidth = 170;
const cellHeight = 112;
const rows = Math.ceil(manifest.allowedIcons.length / columns);
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cells = [];

for (let index = 0; index < manifest.allowedIcons.length; index += 1) {
  const name = manifest.allowedIcons[index];
  const svgText = await fs.readFile(path.join(root, "svg", `${name}.svg`), "utf8");
  const body = svgText.replace(/^.*?<svg[^>]*>/s, "").replace(/<\/svg>\s*$/s, "");
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = column * cellWidth;
  const y = row * cellHeight;
  cells.push(`<g transform="translate(${x} ${y})">
    <rect x="3" y="3" width="164" height="106" rx="10" fill="#F7FCFE" stroke="#B9E6F2"/>
    <g transform="translate(55 12) scale(2.5)" fill="none" stroke="#0874D1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>
    <text x="85" y="98" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" fill="#17334D">${escape(name)}</text>
  </g>`);
}

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cellWidth}" height="${rows * cellHeight}" viewBox="0 0 ${columns * cellWidth} ${rows * cellHeight}">
  <rect width="100%" height="100%" fill="white"/>
  ${cells.join("\n")}
</svg>`;
await fs.mkdir(path.dirname(output), { recursive: true });
await sharp(Buffer.from(sheet)).png().toFile(output);
console.log(output);
