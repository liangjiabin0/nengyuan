import { tool } from '@opencode-ai/plugin';

const DEFAULT_API = 'http://127.0.0.1:4000';

function apiBase() {
  return (process.env.AI4ES_API_URL || process.env.API_BASE_URL || DEFAULT_API).replace(/\/+$/, '');
}

async function callAgent(payload: Record<string, unknown>) {
  const token = String(process.env.AI4ES_AGENT_API_TOKEN || '').trim();
  if (!token) throw new Error('自学习服务令牌未配置，请重启 OpenCode sidecar。');
  const url = `${apiBase()}/api/self-learning/agent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data: {
    error?: string;
    count?: number;
    memories?: Array<Record<string, unknown>>;
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`自学习接口无效响应（HTTP ${response.status}）：${text.slice(0, 240)}`);
  }
  if (!response.ok) {
    throw new Error(data.error || `自学习接口失败（HTTP ${response.status}）`);
  }
  return data;
}

export default tool({
  description:
    '按当前问题检索当前用户已保存、但未钉住的自学习记忆。查询必须是当前问题改写的短词，不要拼历史对话。没有命中就当没有相关记忆，不要声称记得。保存记忆仍须先加载 self-learning。',
  args: {
    query: tool.schema
      .string()
      .describe('当前问题的短查询，例如“引文”或“emoji”。不要附带上一轮对话')
  },
  async execute(args, context) {
    const query = String(args.query || '').trim();
    if (!query) return '没有相关记忆。';
    try {
      const result = await callAgent({
        action: 'search',
        workspace: context.directory,
        query
      });
      const memories = Array.isArray(result.memories) ? result.memories : [];
      if (!memories.length) return '没有相关记忆。';
      return [
        `检索到 ${result.count ?? memories.length} 条相关记忆。只在适用条件满足且不与当前请求冲突时使用：`,
        ...memories.map((memory, index) => {
          const applicability = memory.applicability ? ` 适用：${memory.applicability}` : '';
          return `${index + 1}. 【${memory.domainLabel || memory.domainKey}】${memory.instruction}${applicability}`;
        })
      ].join('\n');
    } catch (error) {
      return `自学习检索失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
});
