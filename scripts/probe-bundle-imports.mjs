import fs from 'node:fs';

const files = ['dist/runtime/api-app.mjs', 'dist/runtime/worker-app.mjs', 'dist/runtime/check-postgres-app.mjs'];
const specs = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const match of src.matchAll(/(?:from|import)\(?\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (!spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('/')) specs.add(spec);
  }
}

const failures = [];
for (const spec of [...specs].sort()) {
  try {
    await import(spec);
    console.log(`ok ${spec}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`FAIL ${spec} :: ${message}`);
    failures.push(spec);
  }
}
console.log(`failures ${failures.length}`);
process.exit(failures.length ? 1 : 0);
