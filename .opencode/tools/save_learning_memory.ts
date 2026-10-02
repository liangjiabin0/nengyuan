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
    ok?: boolean;
    count?: number;
    memory?: Record<string, unknown>;
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
    '把当前用户明确要求记住的私有经验写入自学习记忆。必须先调用 skill 加载 self-learning，再使用本工具。用户说学习、记住、记下、沉淀、写进记忆时，先加载该技能。不要改全局技能。沟通习惯默认存到通用对话。',
  args: {
    action: tool.schema
      .enum(['save', 'list'])
      .optional()
      .describe('save 写入一条记忆（默认）；list 查看当前用户已保存记忆'),
    instruction: tool.schema
      .string()
      .optional()
      .describe('可独立理解的规则正文，不要照抄整段对话'),
    kind: tool.schema
      .enum(['instruction', 'preference', 'workflow', 'correction'])
      .optional()
      .describe('instruction 指令；preference 偏好；workflow 做法；correction 纠错'),
    applicability: tool.schema
      .string()
      .optional()
      .describe('何时适用，例如全部回复、专利撰写、综述引文'),
    operation: tool.schema.string().optional().describe('已经验证有效的做法，可空'),
    keywords: tool.schema.string().optional().describe('逗号分隔关键词'),
    domain_label: tool.schema
      .string()
      .optional()
      .describe('领域中文名。沟通/回复习惯用「通用对话」；技能专属流程再写具体领域')
  },
  async execute(args, context) {
    const action = String(args.action || 'save');
    try {
      const result = await callAgent({
        action,
        workspace: context.directory,
        instruction: args.instruction,
        kind: args.kind,
        operation: args.operation,
        applicability: args.applicability,
        keywords: args.keywords,
        domainLabel: args.domain_label
      });
      if (action === 'list') {
        const memories = Array.isArray(result.memories) ? result.memories : [];
        if (!memories.length) return '当前用户还没有已保存的自学习记忆。';
        return [
          `当前用户已有 ${result.count ?? memories.length} 条自学习记忆：`,
          ...memories.map((memory, index) => (
            `${index + 1}. 【${memory.domainLabel || memory.domainKey}】${memory.instruction}`
          ))
        ].join('\n');
      }
      const memory = result.memory || {};
      return [
        `已保存到【${memory.domainLabel || '通用对话'}】。`,
        `规则：${memory.instruction || args.instruction || ''}`,
        memory.applicability ? `适用：${memory.applicability}` : '',
        memory.id ? `记忆 id：${memory.id}` : ''
      ].filter(Boolean).join('\n');
    } catch (error) {
      return `自学习保存失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
});
