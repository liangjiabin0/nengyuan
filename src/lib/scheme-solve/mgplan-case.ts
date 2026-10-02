import fs from 'node:fs';
import path from 'node:path';
import { MGPLAN_CASE, MGPLAN_ENGINE, resolveMgplanRoot } from './mgplan';
import { schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export const MGPLAN_SMALL_TABLES = [
  { key: 'option', file: `oT_Data_Option_${MGPLAN_CASE}.csv`, label: 'Option' },
  { key: 'parameter', file: `oT_Data_Parameter_${MGPLAN_CASE}.csv`, label: 'Parameter' },
  { key: 'generation', file: `oT_Data_Generation_${MGPLAN_CASE}.csv`, label: 'Generation' },
  { key: 'network', file: `oT_Data_Network_${MGPLAN_CASE}.csv`, label: 'Network' },
  { key: 'nodeLocation', file: `oT_Data_NodeLocation_${MGPLAN_CASE}.csv`, label: 'NodeLocation' }
] as const;

export const MGPLAN_TIMESERIES = [
  { key: 'demand', file: `oT_Data_Demand_${MGPLAN_CASE}.csv`, label: 'Demand' },
  { key: 'price', file: `oT_Data_ElectricityPrice_${MGPLAN_CASE}.csv`, label: 'ElectricityPrice' },
  { key: 'maxGen', file: `oT_Data_VariableMaxGeneration_${MGPLAN_CASE}.csv`, label: 'VariableMaxGeneration' },
  { key: 'loadLevel', file: `oT_Dict_LoadLevel_${MGPLAN_CASE}.csv`, label: 'LoadLevel' },
  { key: 'ev', file: `oT_Data_EV_${MGPLAN_CASE}.csv`, label: 'EV' }
] as const;

export const MGPLAN_SKIP_FIXTURE_FILES = new Set([`oT_Result_BalanceEnergy_${MGPLAN_CASE}.csv`]);

export type MgplanCsvTable = {
  key: string;
  file: string;
  label: string;
  headers: string[];
  rows: string[][];
};

export type MgplanTimeseriesPreview = {
  key: string;
  file: string;
  label: string;
  exists: boolean;
  rowCount: number;
  headers: string[];
  head: string[][];
  tail: string[][];
  stats: Array<{ column: string; min: number | null; max: number | null; mean: number | null }>;
};

export function mgplanConfigDir(sessionId: string, ideaId: string) {
  return path.join(schemeIdeaDirectory(sessionId, ideaId), 'mgplan', 'config');
}

export function mgplanOutputDir(sessionId: string, ideaId: string) {
  return path.join(schemeIdeaDirectory(sessionId, ideaId), 'mgplan', 'output');
}

export function templateConfigDir() {
  return path.join(resolveMgplanRoot(), 'config');
}

export function templateOutputDir() {
  return path.join(resolveMgplanRoot(), 'output');
}

export function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]!);
  const rows = lines.slice(1).map(splitCsvLine);
  return { headers, rows };
}

export function stringifyCsv(headers: string[], rows: string[][]) {
  const lines = [headers, ...rows].map((cells) => cells.map(escapeCsvCell).join(','));
  return `${lines.join('\n')}\n`;
}

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function escapeCsvCell(value: string) {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function copyDir(src: string, dest: string, skip = new Set<string>()) {
  if (!fs.existsSync(src)) throw new Error(`模板目录不存在：${src}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    if (skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, skip);
    else fs.copyFileSync(from, to);
  }
}

export function writeMgplanModelJson(sessionId: string, ideaId: string) {
  writeWorkspaceText(
    sessionId,
    ideaId,
    'model.json',
    `${JSON.stringify({ engine: MGPLAN_ENGINE, case: MGPLAN_CASE, configDir: 'mgplan/config' }, null, 2)}\n`
  );
}

export function prepareMgplanWorkspace(sessionId: string, ideaId: string, options?: { seedFixture?: boolean }) {
  const configDir = mgplanConfigDir(sessionId, ideaId);
  const outputDir = mgplanOutputDir(sessionId, ideaId);
  if (!fs.existsSync(path.join(configDir, `oT_Data_Option_${MGPLAN_CASE}.csv`))) {
    copyDir(templateConfigDir(), configDir);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  if (options?.seedFixture !== false && !hasMgplanOutput(outputDir)) {
    seedMgplanFixtureOutput(outputDir);
  }
  writeMgplanModelJson(sessionId, ideaId);
  return { configDir, outputDir };
}

export function hasMgplanOutput(outputDir: string) {
  return fs.existsSync(path.join(outputDir, `oT_Result_CostSummary_${MGPLAN_CASE}.csv`));
}

export function seedMgplanFixtureOutput(outputDir: string) {
  const src = templateOutputDir();
  if (!fs.existsSync(src)) return false;
  copyDir(src, outputDir, MGPLAN_SKIP_FIXTURE_FILES);
  return true;
}

export function readSmallTables(configDir: string): MgplanCsvTable[] {
  return MGPLAN_SMALL_TABLES.map((item) => {
    const filePath = path.join(configDir, item.file);
    const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const parsed = parseCsvText(raw);
    return { ...item, ...parsed };
  });
}

export function writeSmallTables(configDir: string, tables: Array<{ key: string; headers: string[]; rows: string[][] }>) {
  fs.mkdirSync(configDir, { recursive: true });
  const byKey = new Map(tables.map((item) => [item.key, item]));
  for (const item of MGPLAN_SMALL_TABLES) {
    const table = byKey.get(item.key);
    if (!table) continue;
    fs.writeFileSync(path.join(configDir, item.file), stringifyCsv(table.headers, table.rows), 'utf8');
  }
}

function toNumber(value: string) {
  const parsed = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function previewTimeseries(configDir: string, key?: string, previewRows = 5): MgplanTimeseriesPreview[] {
  const targets = key ? MGPLAN_TIMESERIES.filter((item) => item.key === key) : [...MGPLAN_TIMESERIES];
  return targets.map((item) => {
    const filePath = path.join(configDir, item.file);
    if (!fs.existsSync(filePath)) {
      return {
        ...item,
        exists: false,
        rowCount: 0,
        headers: [],
        head: [],
        tail: [],
        stats: []
      };
    }
    const parsed = parseCsvText(fs.readFileSync(filePath, 'utf8'));
    const numericCols = parsed.headers
      .map((header, index) => ({ header, index }))
      .filter(({ header }) => !/^(Period|Scenario|LoadLevel|Node)$/i.test(header));
    const stats = numericCols.map(({ header, index }) => {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      let sum = 0;
      let count = 0;
      for (const row of parsed.rows) {
        const value = toNumber(row[index] || '');
        if (value == null) continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
        sum += value;
        count += 1;
      }
      return {
        column: header,
        min: count ? min : null,
        max: count ? max : null,
        mean: count ? sum / count : null
      };
    });
    return {
      ...item,
      exists: true,
      rowCount: parsed.rows.length,
      headers: parsed.headers,
      head: parsed.rows.slice(0, previewRows),
      tail: parsed.rows.slice(-previewRows),
      stats
    };
  });
}

export function writeTimeseriesCsv(configDir: string, key: string, content: string) {
  const item = MGPLAN_TIMESERIES.find((entry) => entry.key === key);
  if (!item) throw new Error(`未知时序表：${key}`);
  const parsed = parseCsvText(content);
  if (!parsed.headers.length) throw new Error('上传的 CSV 没有表头。');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, item.file), stringifyCsv(parsed.headers, parsed.rows), 'utf8');
  return previewTimeseries(configDir, key)[0];
}

export function restoreTimeseriesTemplate(configDir: string, key: string) {
  const item = MGPLAN_TIMESERIES.find((entry) => entry.key === key);
  if (!item) throw new Error(`未知时序表：${key}`);
  const src = path.join(templateConfigDir(), item.file);
  if (!fs.existsSync(src)) throw new Error(`模板不存在：${item.file}`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(src, path.join(configDir, item.file));
  return previewTimeseries(configDir, key)[0];
}

export function listConfigFiles(configDir: string) {
  if (!fs.existsSync(configDir)) return [];
  return fs.readdirSync(configDir).filter((name) => !name.startsWith('.') && !name.endsWith('.pyc'));
}

export function listOutputFiles(outputDir: string) {
  if (!fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir).filter((name) => !name.startsWith('.'));
}

export function safeMgplanFilePath(rootDir: string, fileName: string) {
  const base = path.basename(fileName);
  if (!/^oT_[A-Za-z0-9_.-]+$/.test(base) && !/^calculation_config\.py$/.test(base)) {
    throw new Error('非法文件名。');
  }
  const resolved = path.resolve(rootDir, base);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('非法路径。');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('文件不存在。');
  }
  return resolved;
}
