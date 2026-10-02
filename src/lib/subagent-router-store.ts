// 【重建】原文件已丢失，按 dist/runtime/api-app.mjs 还原并补回类型。
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeSubagentRouterConfig,
  publicSubagentRouterConfig,
  type SubagentRouterConfig
} from './subagent-router';

const settingsPath = path.join(process.cwd(), 'storage', 'settings.json');
/** OpenCode 插件读取的路由配置 */
const openCodeRouterPath = path.join(process.cwd(), '.opencode', 'subagent-router.json');
/** 旧版名字（classifier），同步时删掉 */
const legacyOpenCodeClassifierPath = path.join(process.cwd(), '.opencode', 'classifier.json');

function readStoredFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getSubagentRouterConfig(): SubagentRouterConfig {
  const stored = readStoredFile(settingsPath);
  return normalizeSubagentRouterConfig(stored.subagentRouter ?? stored.classifier);
}

export function saveSubagentRouterConfig(input: unknown): SubagentRouterConfig {
  const next = normalizeSubagentRouterConfig(input);
  const stored = readStoredFile(settingsPath);
  stored.subagentRouter = publicSubagentRouterConfig(next);
  delete stored.classifier;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(stored, null, 2)}\n`);
  syncOpenCodeSubagentRouter(next);
  return next;
}

/** 把路由配置写到 .opencode/subagent-router.json，内容没变就不写 */
export function syncOpenCodeSubagentRouter(config: SubagentRouterConfig = getSubagentRouterConfig()) {
  try {
    const next = `${JSON.stringify(publicSubagentRouterConfig(config), null, 2)}\n`;
    const current = fs.existsSync(openCodeRouterPath) ? fs.readFileSync(openCodeRouterPath, 'utf8') : '';
    if (current !== next) {
      fs.mkdirSync(path.dirname(openCodeRouterPath), { recursive: true });
      fs.writeFileSync(openCodeRouterPath, next);
    }
    if (fs.existsSync(legacyOpenCodeClassifierPath)) {
      fs.rmSync(legacyOpenCodeClassifierPath, { force: true });
    }
  } catch {
    // 同步失败不影响主流程
  }
}
