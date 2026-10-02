import fs from 'node:fs';
import path from 'node:path';

const targets = [
  {
    file: path.join(process.cwd(), 'node_modules', 'next', 'dist', 'build', 'route-discovery.js'),
    before: 'return paths.filter((p)=>debugPathsSet.has(p));',
    after: 'return paths.filter((p)=>debugPathsSet.has((0, _normalizepathsep.normalizePathSep)(p)));'
  },
  {
    file: path.join(process.cwd(), 'node_modules', 'next', 'dist', 'esm', 'build', 'route-discovery.js'),
    before: 'return paths.filter((p)=>debugPathsSet.has(p));',
    after: 'return paths.filter((p)=>debugPathsSet.has(normalizePathSep(p)));'
  }
];

for (const target of targets) {
  if (!fs.existsSync(target.file)) continue;
  const source = fs.readFileSync(target.file, 'utf8');
  if (source.includes(target.after)) continue;
  if (!source.includes(target.before)) {
    throw new Error(`Unsupported Next.js route-discovery layout: ${target.file}`);
  }
  fs.writeFileSync(target.file, source.replace(target.before, target.after));
  console.log(`[postinstall] patched Windows debug-build-path matching: ${path.relative(process.cwd(), target.file)}`);
}
