import { executeTool } from '../src/lib/tools/registry';

async function main() {
  const cases = [
    { domain: 'paper', group_by: 'university_or_school' },
    { domain: 'paper', group_by: 'school' },
    { domain: 'mentor', group_by: 'school', limit: 5 }
  ];

  for (const args of cases) {
    console.log('\n===', JSON.stringify(args));
    const result = await executeTool('analytics.group_by', args, {
      question: '论文都有哪些大学的',
      llmContext: '',
      retrievalContext: '',
      evidenceOffset: 0
    });
    console.log(result.summary);
    if (result.contextText) console.log(result.contextText.split('\n').slice(0, 8).join('\n'));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
