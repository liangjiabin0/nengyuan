import fs from 'node:fs';
import path from 'node:path';

export type BundleMeta = {
  activeRoot: string;
  databasePath: string;
  importedAt: string;
  format: string;
  version: number;
};

const metaPath = () => path.join(process.cwd(), 'storage', 'ragpack-meta.json');
const defaultBundleRoot = () => path.join(process.cwd(), 'storage', 'ragpack', 'active');

function readBundleMeta(): BundleMeta | null {
  try {
    if (!fs.existsSync(metaPath())) return null;
    return JSON.parse(fs.readFileSync(metaPath(), 'utf8')) as BundleMeta;
  } catch {
    return null;
  }
}

export function getBundleDatabasePath(): string | null {
  const meta = readBundleMeta();
  if (meta?.databasePath && fs.existsSync(meta.databasePath)) return meta.databasePath;
  const fallback = path.join(defaultBundleRoot(), 'database', 'rag.sqlite');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

export function getBundleRoot(): string | null {
  const meta = readBundleMeta();
  if (meta?.activeRoot && fs.existsSync(meta.activeRoot)) return meta.activeRoot;
  const fallback = defaultBundleRoot();
  if (fs.existsSync(path.join(fallback, 'manifest.json'))) return fallback;
  return null;
}

export function setBundleMeta(meta: BundleMeta) {
  fs.mkdirSync(path.dirname(metaPath()), { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

export function getAllowedAssetRoots(dataRootDir: string) {
  const roots = [
    path.resolve(dataRootDir),
    path.resolve(process.cwd(), 'data'),
    path.resolve(process.cwd(), 'storage')
  ];
  const bundle = getBundleRoot();
  if (bundle) roots.unshift(path.resolve(bundle));
  return [...new Set(roots)];
}

export function isPathUnderAllowedRoots(filePath: string, dataRootDir: string) {
  const resolved = path.resolve(filePath);
  return getAllowedAssetRoots(dataRootDir).some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
}
