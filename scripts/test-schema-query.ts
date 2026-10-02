import { executeTool } from '../src/lib/tools/registry';

const ctx = {
  question: '论文都有哪些大学的',
  llmContext: '',
  retrievalContext: '',
  evidenceOffset: 0
};

async function main() {
  console.log('=== describe_schema ===');
  const schema = await executeTool('catalog.describe_schema', {}, ctx);
  console.log(schema.summary);
  console.log(schema.contextText?.split('\n').slice(0, 12).join('\n'));

  console.log('\n=== group_by mentor school ===');
  const mentors = await executeTool(
    'analytics.group_by',
    { table: 'mentor_profiles', column: 'school', limit: 5 },
    ctx
  );
  console.log(mentors.summary);

  console.log('\n=== safe_query ===');
  const sql = await executeTool(
    'analytics.safe_query',
    {
      sql: `SELECT institution as k, COUNT(*) as c FROM projects WHERE institution IS NOT NULL AND institution != '' GROUP BY institution ORDER BY c DESC LIMIT 5`
    },
    ctx
  );
  console.log(sql.summary);

  console.log('\n=== group_by paper school (fallback) ===');
  const papers = await executeTool(
    'analytics.group_by',
    { table: 'paper_documents', column: 'school', limit: 5 },
    ctx
  );
  console.log(papers.summary);

  console.log('\n=== invalid column hint ===');
  const bad = await executeTool(
    'analytics.group_by',
    { table: 'paper_documents', column: 'not_a_column' },
    ctx
  );
  console.log(bad.summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
