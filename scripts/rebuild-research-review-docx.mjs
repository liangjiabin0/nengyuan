import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(
  pathToFileURL(path.resolve('src/lib/research-review/export.ts')).href
);

let markdown = '';
const finalPath = path.resolve('storage/test-fixtures/final-answer.md');
const sessionPath = path.resolve('storage/test-fixtures/session-messages.json');
if (fs.existsSync(finalPath)) {
  markdown = fs.readFileSync(finalPath, 'utf8');
} else if (fs.existsSync(sessionPath)) {
  const msgs = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const texts = [];
  for (const m of msgs) {
    for (const p of m.parts || []) {
      if (p.type === 'text' && p.text && m.info?.role === 'assistant') texts.push(p.text);
    }
  }
  markdown = texts.sort((a, b) => b.length - a.length)[0] || '';
} else {
  throw new Error('No source markdown found');
}

const cleaned = mod.prepareResearchReviewMarkdown(markdown);
console.log('sourceChars', markdown.length, 'cleanedChars', cleaned.length);
console.log('cleanedHead:', cleaned.slice(0, 200).replace(/\n/g, ' | '));
const buf = await mod.buildResearchReviewDocx(markdown, 'research-review');
const out = path.resolve('outputs/research-review-improved.docx');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log('wrote', out, buf.length);
