import { langchainRetrieve } from '../src/lib/langchain/pipeline';
import { mentorDirectionRetrieve } from '../src/lib/mentor-retrieval';

const q = '哪些导师的研究方向涉及虚拟电厂？请列出姓名、学校和邮箱。';

async function main() {
  const mentors = await mentorDirectionRetrieve(q, '', 12);
  console.log('mentorDirectionRetrieve top6:');
  for (const m of mentors.slice(0, 6)) {
    console.log(m.score, m.title.slice(0, 70), m.body.includes('虚拟电厂'), m.body.includes('刘佩'));
  }
  const r = await langchainRetrieve(q, '', { limit: 12 });
  console.log('\npipeline top6:');
  for (const m of r.results.slice(0, 6)) {
    console.log(m.sourceType, m.score, m.title.slice(0, 70), `${m.body}`.includes('虚拟电厂'), `${m.body}`.includes('刘佩'));
  }
}

main().catch(console.error);
