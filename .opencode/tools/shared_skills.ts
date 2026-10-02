import { tool } from '@opencode-ai/plugin';

const DEFAULT_API = 'http://127.0.0.1:4000';

function apiBase() {
  return (process.env.AI4ES_API_URL || process.env.API_BASE_URL || DEFAULT_API).replace(/\/+$/, '');
}

async function callAgent(payload: Record<string, unknown>) {
  const token = String(process.env.AI4ES_AGENT_API_TOKEN || '').trim();
  if (!token) throw new Error('技能库服务令牌未配置，请重启 OpenCode sidecar。');
  const url = `${apiBase()}/api/skills/agent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data: { error?: string; skills?: unknown; skill?: unknown; markdown?: string; files?: string[]; created?: boolean };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`技能库接口无效响应（HTTP ${response.status}）：${text.slice(0, 240)}`);
  }
  if (!response.ok) {
    throw new Error(data.error || `技能库接口失败（HTTP ${response.status}）`);
  }
  return data;
}

function formatSkill(skill: Record<string, unknown> | undefined) {
  if (!skill) return '';
  return [
    `名称：${skill.name || ''}`,
    `标题：${skill.title || skill.name || ''}`,
    `说明：${skill.description || '（无）'}`,
    `id：${skill.id || ''}`,
    skill.uploadedByName ? `发布者：${skill.uploadedByName}` : ''
  ].filter(Boolean).join('\n');
}

export default tool({
  description:
    '管理团队共享技能库：列出、读取、安装、更新 shared-* 技能。用户要求编写/安装/修改技能、或想查看技能库时使用。安装后全员可在技能库页面和对话加号里看到；本轮要用 skill 工具再加载同名技能。不要用它改写 patent-*、paper-reproduce 等内置 skill。',
  args: {
    action: tool.schema
      .enum(['list', 'read', 'install', 'update'])
      .describe('list 列出目录；read 读正文；install 新建；update 覆盖已有 SKILL.md'),
    name: tool.schema
      .string()
      .optional()
      .describe('技能名，小写字母/数字/连字符。install 时可不带 shared- 前缀'),
    title: tool.schema.string().optional().describe('展示标题，可中文'),
    description: tool.schema
      .string()
      .optional()
      .describe('一句话说明：做什么、何时用'),
    markdown: tool.schema
      .string()
      .optional()
      .describe('完整 SKILL.md（含 YAML frontmatter）。install/update 优先用这个'),
    body: tool.schema
      .string()
      .optional()
      .describe('没有完整 markdown 时的正文；工具会补 frontmatter')
  },
  async execute(args) {
    const action = String(args.action || 'list');
    try {
      const result = await callAgent({
        action,
        name: args.name,
        title: args.title,
        description: args.description,
        markdown: args.markdown,
        body: args.body
      });
      if (action === 'list') {
        const skills = Array.isArray(result.skills) ? result.skills as Array<Record<string, unknown>> : [];
        if (!skills.length) {
          return '共享技能库是空的。可用 install 写入 SKILL.md，发布后全员可见。';
        }
        return [
          `共享技能库 ${skills.length} 个：`,
          ...skills.map((skill, index) => (
            `${index + 1}. ${skill.name} — ${skill.title || skill.name}\n   ${skill.description || '无说明'}`
          )),
          '',
          '读取用 action=read；加载到本轮推理用 skill 工具并传入上述 name。'
        ].join('\n');
      }
      const skill = result.skill as Record<string, unknown> | undefined;
      const lines = [
        action === 'install' && result.created ? '已安装到共享技能库。' : '',
        action === 'update' || (action === 'install' && !result.created) ? '已更新共享技能。' : '',
        formatSkill(skill),
        result.files?.length ? `文件：${result.files.join('、')}` : '',
        result.markdown ? `\n--- SKILL.md ---\n${result.markdown}` : '',
        skill?.name ? `\n本轮若要按该技能执行，请立刻用 skill 工具加载 \`${skill.name}\`。` : ''
      ].filter(Boolean);
      return lines.join('\n');
    } catch (error) {
      return `技能库操作失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
});
