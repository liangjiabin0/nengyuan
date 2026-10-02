import { tool } from '@opencode-ai/plugin';

const DEFAULT_BASE = 'http://10.1.4.166:8080';
const MAX_FETCH = 5;
const FETCH_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_CHARS = 6000;

function searxngBase() {
  return (process.env.SEARXNG_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function fetchText(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; AI4ES-WebSearch/1.0; +http://localhost) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });
    if (!response.ok) {
      return { ok: false as const, status: response.status, text: '' };
    }
    const text = await response.text();
    return { ok: true as const, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

type SearxResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  engines?: string[];
  score?: number;
};

export default tool({
  description:
    '通过内网 SearXNG 进行通用互联网检索。可用于导师档案、新闻、机构介绍、技术资料、公开网页事实等。由你自主判断是否需要联网；本地 knowledge-corpus 能回答时优先用语料。禁止检索 knowledge-corpus/mentors（已停用）。',
  args: {
    query: tool.schema.string().describe('检索词，尽量具体，可含关键词、人名、学校、机构或 site: 限定'),
    fetch_top: tool.schema
      .number()
      .optional()
      .describe('抓取前 N 条结果页面正文（默认 3，最大 5）。设为 0 则只返回搜索摘要'),
    language: tool.schema
      .string()
      .optional()
      .describe('SearXNG language 参数，默认 zh-CN')
  },
  async execute(args) {
    const query = String(args.query || '').trim();
    if (!query) return '错误：query 不能为空';

    const fetchTopRaw = args.fetch_top === undefined || args.fetch_top === null ? 3 : Number(args.fetch_top);
    const fetchTop = Number.isFinite(fetchTopRaw)
      ? Math.max(0, Math.min(MAX_FETCH, Math.floor(fetchTopRaw)))
      : 3;
    const language = String(args.language || 'zh-CN').trim() || 'zh-CN';

    const base = searxngBase();
    const searchUrl = new URL(`${base}/search`);
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('language', language);

    let payload: { results?: SearxResult[]; number_of_results?: number; query?: string };
    try {
      const searched = await fetchText(searchUrl.toString(), SEARCH_TIMEOUT_MS);
      if (!searched.ok) {
        return `SearXNG 搜索失败：HTTP ${searched.status}（${base}）`;
      }
      payload = JSON.parse(searched.text) as typeof payload;
    } catch (error) {
      return `SearXNG 不可用（${base}）：${error instanceof Error ? error.message : String(error)}`;
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    if (!results.length) {
      return `未找到与「${query}」相关的网页结果。可换更具体关键词、换语言，或改用内置 webfetch 打开已知 URL。`;
    }

    const lines: string[] = [
      `检索引擎：SearXNG (${base})`,
      `查询：${query}`,
      `语言：${language}`,
      `命中约 ${payload.number_of_results ?? results.length} 条，展示前 ${Math.min(results.length, 10)} 条摘要。`,
      ''
    ];

    const top = results.slice(0, 10);
    top.forEach((item, index) => {
      const title = (item.title || '(无标题)').trim();
      const url = (item.url || '').trim();
      const snippet = (item.content || '').trim().slice(0, 280);
      const engine = item.engine || (item.engines || []).join(',') || '';
      lines.push(`${index + 1}. ${title}`);
      if (url) lines.push(`   URL: ${url}`);
      if (snippet) lines.push(`   摘要: ${snippet}`);
      if (engine) lines.push(`   来源引擎: ${engine}`);
      lines.push('');
    });

    if (fetchTop > 0) {
      lines.push(`--- 正文抓取（前 ${fetchTop} 条）---`, '');
      for (let index = 0; index < Math.min(fetchTop, top.length); index += 1) {
        const item = top[index];
        const url = (item.url || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) {
          lines.push(`#${index + 1} 跳过：无效 URL`);
          continue;
        }
        try {
          const page = await fetchText(url, FETCH_TIMEOUT_MS);
          if (!page.ok) {
            lines.push(`#${index + 1} 抓取失败 HTTP ${page.status}: ${url}`);
            continue;
          }
          const text = stripHtml(page.text).slice(0, MAX_PAGE_CHARS);
          lines.push(`#${index + 1} ${item.title || url}`);
          lines.push(`URL: ${url}`);
          lines.push(text || '(页面无可提取文本)');
          lines.push('');
        } catch (error) {
          lines.push(
            `#${index + 1} 抓取异常: ${url} — ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    lines.push(
      '说明：以上为检索结果。是否在最终回答中标注 URL/语料路径，必须遵循当前 Agent 的输出规范；若任务要求输出结构化 JSON 或正式公文，不要把 URL、路径或方括号引用写进正文字段。'
    );
    return lines.join('\n');
  }
});
