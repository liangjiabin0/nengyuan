import Database from 'better-sqlite3';
import { config } from '../src/lib/config';
import { langchainRetrieve } from '../src/lib/langchain/pipeline';
import { searchRecords } from '../src/lib/search-index';

const name = process.argv[2] || '牛泽原';
const q = `%${name}%`;
const db = new Database(config.databasePath, { readonly: true });

const hits = {
  mentors: db.prepare('SELECT COUNT(*) as c FROM mentor_profiles WHERE name LIKE ? OR content LIKE ?').get(q, q) as { c: number },
  papers: db.prepare('SELECT COUNT(*) as c FROM paper_documents WHERE title LIKE ? OR authors LIKE ?').get(q, q) as { c: number },
  chunks: db.prepare('SELECT COUNT(*) as c FROM paper_chunks WHERE text LIKE ?').get(q) as { c: number },
  projects: db.prepare('SELECT COUNT(*) as c FROM projects WHERE principal_investigator LIKE ? OR participants LIKE ? OR project_name LIKE ?').get(q, q, q) as { c: number },
  search: db.prepare('SELECT COUNT(*) as c FROM search_records WHERE body LIKE ? OR title LIKE ?').get(q, q) as { c: number },
  entities: db.prepare('SELECT COUNT(*) as c FROM entities WHERE name LIKE ?').get(q) as { c: number }
};

console.log('=== 数据库直查 ===', name, hits);

const mentor = db.prepare('SELECT name, school, college, major, substr(content,1,200) as preview FROM mentor_profiles WHERE name LIKE ? OR content LIKE ? LIMIT 3').all(q, q);
console.log('导师样本:', mentor);

const searchSample = db.prepare(`SELECT source_type, title, substr(body,1,160) as preview FROM search_records WHERE body LIKE ? OR title LIKE ? LIMIT 5`).all(q, q);
console.log('search_records 样本:', searchSample);

db.close();

async function main() {
  const query = `${name}是谁`;
  console.log('\n=== 检索测试 ===', query);
  const direct = await searchRecords(query, { limit: 8 });
  console.log('searchRecords top:', direct.slice(0, 5).map((r) => ({ score: r.score, type: r.sourceType, title: r.title.slice(0, 80), hasName: r.body.includes(name) })));

  const retrieved = await langchainRetrieve(query, '', { limit: 12 });
  console.log('langchain top:', retrieved.results.slice(0, 5).map((r) => ({ score: r.score, type: r.sourceType, title: r.title.slice(0, 80), hasName: (r.body + JSON.stringify(r.fields)).includes(name) })));
  console.log('confidence:', retrieved.confidence, 'intent:', retrieved.parsed.intent);
}

main().catch(console.error);
