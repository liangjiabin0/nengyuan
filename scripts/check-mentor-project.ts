import Database from 'better-sqlite3';
import { config } from '../src/lib/config';

const db = new Database(config.databasePath, { readonly: true });

const projects = db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number };
const fillRate = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN principal_investigator IS NOT NULL AND principal_investigator != '' THEN 1 ELSE 0 END) AS with_pi,
    SUM(CASE WHEN grant_name IS NOT NULL AND grant_name != '' THEN 1 ELSE 0 END) AS with_grant,
    SUM(CASE WHEN grant_name LIKE '%国家%' THEN 1 ELSE 0 END) AS national_like,
    SUM(CASE WHEN grant_name LIKE '%省%' OR grant_name LIKE '%市%' OR grant_category LIKE '%省%' THEN 1 ELSE 0 END) AS provincial_like
  FROM projects
`).get();
const mentors = db.prepare('SELECT COUNT(*) as c FROM mentor_profiles').get() as { c: number };

const grants = db.prepare(`
  SELECT grant_category, grant_name, COUNT(*) as c
  FROM projects
  GROUP BY grant_category, grant_name
  ORDER BY c DESC
  LIMIT 15
`).all();

const sampleProject = db.prepare(`
  SELECT project_name, principal_investigator, grant_name, grant_category, year
  FROM projects
  LIMIT 5
`).all();

const mentorSample = db.prepare(`
  SELECT name, school, substr(content, 1, 300) as preview
  FROM mentor_profiles
  LIMIT 3
`).all();

const overlap = db.prepare(`
  SELECT m.name, COUNT(p.project_key) as project_count
  FROM mentor_profiles m
  JOIN projects p ON p.principal_investigator LIKE '%' || m.name || '%'
  GROUP BY m.name
  ORDER BY project_count DESC
  LIMIT 10
`).all();

console.log('项目数:', projects.c, '导师数:', mentors.c);
console.log('项目字段完整度:', fillRate);
console.log('\n项目资助类别样本:', grants);
console.log('\n项目记录样本:', sampleProject);
console.log('\n导师样本:', mentorSample);
console.log('\n导师姓名与项目负责人匹配:', overlap.length ? overlap : '（导师未入库或无匹配）');

db.close();
