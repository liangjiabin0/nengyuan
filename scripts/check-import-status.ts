import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveDataSubdirs } from '../src/lib/data-dirs';
import { config } from '../src/lib/config';

const rootDir = process.argv[2] || 'E:\\研究院数据\\DATA';
const jobPath = path.join(process.cwd(), 'storage', 'import-job.json');

console.log('=== 导入任务状态 ===');
if (fs.existsSync(jobPath)) {
  console.log(fs.readFileSync(jobPath, 'utf8'));
} else {
  console.log('无 import-job.json');
}

console.log('\n=== 数据子分类目录 ===');
const subdirs = resolveDataSubdirs(rootDir);
for (const key of ['papers', 'patents', 'whitepapers', 'funds', 'mentors'] as const) {
  const dir = subdirs[key];
  const topFiles = fs.existsSync(dir) ? fs.readdirSync(dir).slice(0, 5) : [];
  console.log(`${key}: ${dir}`);
  console.log(`  顶层条目: ${fs.existsSync(dir) ? fs.readdirSync(dir).length : 0}, 示例: ${topFiles.join(', ')}`);
}

const dbPath = config.databasePath;
console.log('\n=== 数据库 ===', dbPath);
if (!fs.existsSync(dbPath)) {
  console.log('数据库文件不存在');
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true });
const columns = (db.prepare('PRAGMA table_info(paper_chunks)').all() as Array<{ name: string }>).map((c) => c.name);
console.log('paper_chunks 列:', columns.join(', '));

const stats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM paper_documents) AS papers,
    (SELECT COUNT(*) FROM paper_chunks WHERE chunk_role = 'parent') AS parent_chunks,
    (SELECT COUNT(*) FROM paper_chunks WHERE chunk_role = 'child') AS child_chunks,
    (SELECT COUNT(*) FROM paper_chunks WHERE chunk_role = 'child' AND parent_key IS NOT NULL AND parent_key != '') AS linked_children,
    (SELECT COUNT(*) FROM projects) AS projects,
    (SELECT COUNT(*) FROM mentor_profiles) AS mentors,
    (SELECT COUNT(*) FROM search_records WHERE source_type = 'paper_chunk') AS indexed_child_chunks,
    (SELECT COUNT(*) FROM search_records WHERE source_type = 'mentor') AS indexed_mentors,
    (SELECT COUNT(*) FROM search_records) AS search_records_total
`).get() as Record<string, number>;

console.log('统计:', stats);

const sample = db.prepare(`
  SELECT p.title, 
    SUM(CASE WHEN c.chunk_role = 'parent' THEN 1 ELSE 0 END) AS parents,
    SUM(CASE WHEN c.chunk_role = 'child' THEN 1 ELSE 0 END) AS children,
    SUM(CASE WHEN c.chunk_role = 'child' AND c.parent_key IS NOT NULL AND c.parent_key != '' THEN 1 ELSE 0 END) AS linked
  FROM paper_documents p
  LEFT JOIN paper_chunks c ON c.paper_key = p.paper_key
  GROUP BY p.paper_key
  ORDER BY p.updated_at DESC
  LIMIT 5
`).all();

console.log('\n最近 5 篇论文 Parent-Child 样本:');
for (const row of sample) console.log(row);

const issues: string[] = [];
if (!columns.includes('parent_key')) issues.push('缺少 parent_key 列');
if (!columns.includes('chunk_role')) issues.push('缺少 chunk_role 列');
if (Number(stats.child_chunks) > 0 && Number(stats.linked_children) < Number(stats.child_chunks)) {
  issues.push(`有 ${Number(stats.child_chunks) - Number(stats.linked_children)} 个 child 未关联 parent`);
}
if (Number(stats.indexed_child_chunks) > Number(stats.child_chunks)) {
  issues.push('索引中的 paper_chunk 数量异常（可能含 parent 或未清理）');
}
if (Number(stats.parent_chunks) === 0 && Number(stats.child_chunks) > 0) {
  issues.push('有 child 但无 parent，Parent-Child 未生效');
}

const paperLinkage = db.prepare(`
  SELECT
    SUM(CASE WHEN bad = 0 THEN 1 ELSE 0 END) AS fully_linked_papers,
    SUM(CASE WHEN bad > 0 AND good > 0 THEN 1 ELSE 0 END) AS mixed_papers,
    SUM(CASE WHEN good = 0 THEN 1 ELSE 0 END) AS unlinked_papers
  FROM (
    SELECT paper_key,
      SUM(CASE WHEN parent_key IS NOT NULL AND parent_key != '' THEN 1 ELSE 0 END) AS good,
      SUM(CASE WHEN parent_key IS NULL OR parent_key = '' THEN 1 ELSE 0 END) AS bad
    FROM paper_chunks
    WHERE chunk_role = 'child'
    GROUP BY paper_key
  )
`).get();
console.log('\n论文 Parent 关联分布:', paperLinkage);

const patentFiles = fs.existsSync(subdirs.patents)
  ? fs.readdirSync(subdirs.patents).filter((name) => /\.(pdf|caj)$/i.test(name)).length
  : 0;
const mentorFiles = fs.existsSync(subdirs.mentors)
  ? fs.readdirSync(subdirs.mentors, { recursive: true }).filter((entry) => typeof entry === 'string' && /\.(md|markdown)$/i.test(entry)).length
  : 0;
console.log(
  '\n源文件规模: 论文 PDF/CAJ ~',
  fs.existsSync(subdirs.papers) ? fs.readdirSync(subdirs.papers, { recursive: true }).filter((n) => typeof n === 'string' && /\.(pdf|caj)$/i.test(n)).length : 0,
  '专利',
  patentFiles,
  '白皮书',
  fs.existsSync(subdirs.whitepapers) ? fs.readdirSync(subdirs.whitepapers).filter((n) => /\.(pdf|caj)$/i.test(n)).length : 0,
  '基金表',
  fs.existsSync(subdirs.funds) ? fs.readdirSync(subdirs.funds).filter((n) => /\.(csv|xlsx|xls)$/i.test(n)).length : 0,
  '导师 MD',
  mentorFiles
);

console.log('\n=== 检查结论 ===');
if (issues.length) {
  console.log('问题:');
  for (const issue of issues) console.log(' -', issue);
} else if (Number(stats.papers) > 0) {
  console.log('Parent-Child 结构正常');
} else {
  console.log('论文尚未导入或导入进行中');
}

db.close();
