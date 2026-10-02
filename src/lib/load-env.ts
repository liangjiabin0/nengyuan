import fs from 'node:fs';
import path from 'node:path';

/**
 * Load .env then .env.local into process.env (does not override existing keys).
 * Used by API/Worker which do not get Next.js env loading.
 */
export function loadProjectEnv(cwd = process.cwd()) {
  for (const name of ['.env', '.env.local']) {
    const filePath = path.join(cwd, name);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
