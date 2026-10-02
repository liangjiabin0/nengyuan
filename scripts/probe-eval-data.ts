import { all, get } from '../src/lib/db';

async function main() {
  const mentors = await all<{ name: string; school: string; content: string }>(
    `SELECT name, school, substr(content,1,300) as content FROM mentor_profiles
     WHERE content LIKE '%人工智能与电力系统%' LIMIT 8`
  );
  console.log('mentors AI+power:', mentors.map((m) => ({ name: m.name, school: m.school })));

  const mentors2 = await all<{ name: string; school: string }>(
    `SELECT name, school FROM mentor_profiles WHERE content LIKE '%虚拟电厂%' LIMIT 6`
  );
  console.log('mentors VPP:', mentors2);

  const students = await all<{ text: string; title: string }>(
    `SELECT substr(c.text,1,400) as text, sr.title
     FROM paper_chunks c LEFT JOIN search_records sr ON sr.source_key=c.chunk_key
     WHERE (c.chunk_role='child' OR c.chunk_role='parent')
       AND c.text LIKE '%硕士研究生%' AND c.text LIKE '%研究方向%'
       AND c.text LIKE '%电力系统%'
     LIMIT 10`
  );
  console.log('\nstudents sample:', students.map((s) => {
    const name = s.text.match(/([^\s，,（(]{2,4})\(\d{4}\)/)?.[1] || s.title?.match(/_([^_·]+)/)?.[1];
    const dir = s.text.match(/研究方向[为是：:]([^。\n]{4,40})/)?.[1];
    return { name, dir, title: s.title?.slice(0, 60) };
  }));

  const literals = await all<{ title: string; text: string }>(
    `SELECT sr.title, substr(c.text,1,200) as text FROM paper_chunks c
     JOIN search_records sr ON sr.source_key=c.chunk_key
     WHERE c.text LIKE '%MW%' AND c.text GLOB '*[0-9][0-9]*.[0-9][0-9]*MW*'
     LIMIT 6`
  );
  console.log('\nliterals:', literals.map((l) => ({
    title: l.title?.slice(0, 70),
    anchor: l.text.match(/\d+\.\d+\s*MW/)?.[0]
  })));

  const papers = await all<{ title: string; authors: string }>(
    `SELECT title, authors FROM paper_documents
     WHERE title LIKE '%HVDC%' OR title LIKE '%MMC%' OR title LIKE '%虚拟电厂%' OR title LIKE '%大语言模型%'
     LIMIT 12`
  );
  console.log('\npapers:', papers.map((p) => p.title.slice(0, 70)));

  const projects = await all(
    `SELECT project_name, principal_investigator, grant_name FROM projects LIMIT 8`
  );
  console.log('\nprojects:', projects);

  const personHits = await all(
    `SELECT DISTINCT e.name, e.type FROM entities e WHERE e.type='person' AND (
      e.name IN ('牛泽原','李嘉媚','李兆泽','江昌旭','武宇翔','王之伟','张沛超')
    ) LIMIT 20`
  );
  console.log('\npersons:', personHits);
}

main().catch(console.error);
