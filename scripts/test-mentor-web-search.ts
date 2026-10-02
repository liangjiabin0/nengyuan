/**
 * Direct SearXNG mentor search smoke test (no OpenCode agent).
 * Usage: npx tsx scripts/test-mentor-web-search.ts [query]
 */
const base = (process.env.SEARXNG_BASE_URL || 'http://10.1.4.166:8080').replace(/\/+$/, '');
const query = process.argv.slice(2).join(' ').trim() || '巨云涛 中国农业大学 导师';

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const url = new URL(`${base}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'zh-CN');

  console.log(`SearXNG: ${url.toString()}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results = payload.results || [];
  console.log(`hits=${results.length}`);
  for (const [index, item] of results.slice(0, 8).entries()) {
    console.log(`\n[${index + 1}] ${item.title}`);
    console.log(`    ${item.url}`);
    if (item.content) console.log(`    ${item.content.slice(0, 160)}`);
  }

  const profileLike = results.find((item) =>
    /巨云涛/.test(`${item.title || ''}${item.content || ''}`)
    && /(导师|师资|副教授|教授|学院|农业大学|cau)/i.test(`${item.title || ''}${item.url || ''}${item.content || ''}`)
  );
  if (!profileLike?.url) {
    throw new Error('未找到与巨云涛相关的导师/师资结果');
  }

  console.log(`\nFetching profile-like page: ${profileLike.url}`);
  const page = await fetch(profileLike.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AI4ES-MentorSearch/1.0)',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  const html = await page.text();
  const text = stripHtml(html);
  const hasName = text.includes('巨云涛');
  console.log(`page_http=${page.status} chars=${text.length} has_name=${hasName}`);
  console.log(text.slice(0, 800));

  if (!hasName && page.ok) {
    console.warn('警告：抓取正文未直接出现姓名，但仍有搜索命中。');
  }
  if (!results.some((item) => /巨云涛/.test(`${item.title || ''}${item.content || ''}`))) {
    throw new Error('搜索结果中未出现巨云涛');
  }
  console.log('\nOK: SearXNG 可检索到巨云涛相关档案线索');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
