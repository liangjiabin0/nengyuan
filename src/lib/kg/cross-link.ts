import type { Database } from '../db';
import { withTransaction } from '../db';
import { similarityScore } from '../text';
import { canonicalizeTitle } from './canonicalize';
import { resolveUpsertEdgeInDb, resolveUpsertEntityInDb, findEntityByAlias } from './entity-resolve';
import { autoMergeHighConfidenceInDb } from './merge';
import { rebuildAliasesInDb } from './rebuild-aliases';

async function allInDb<T>(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) return db.prepare(sql).all<T>(...params);
  return db.prepare(sql).all<T>();
}

async function getInDb<T>(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) return db.prepare(sql).get<T>(...params);
  return db.prepare(sql).get<T>();
}

export type CrossLinkResult = {
  personLinks: number;
  institutionLinks: number;
  outputPaperLinks: number;
  mentorPersonLinks: number;
  keywordLinks: number;
  aliases: Awaited<ReturnType<typeof rebuildAliasesInDb>>;
  merge: Awaited<ReturnType<typeof autoMergeHighConfidenceInDb>>;
};

/** 将同名 person 实体与 mentor / project PI / paper authors 对齐（通过别名已处理）；补 same_as 边连接业务主键 */
async function linkPersons(db: Database) {
  let linked = 0;
  const mentors = await allInDb<{ mentor_key: string; name: string }>(
    db,
    'SELECT mentor_key, name FROM mentor_profiles WHERE name IS NOT NULL AND length(trim(name)) > 0'
  );
  for (const mentor of mentors) {
    const personKey = (await findEntityByAlias(db, 'person', mentor.name))?.entity_key
      || await resolveUpsertEntityInDb(db, 'person', mentor.name, { mentorKey: mentor.mentor_key });
    if (!personKey) continue;
    await resolveUpsertEdgeInDb(db, mentor.mentor_key, personKey, 'same_as', 6);
    await resolveUpsertEdgeInDb(db, mentor.mentor_key, personKey, 'entity', 8);
    linked += 1;
  }

  const projects = await allInDb<{ project_key: string; principal_investigator?: string; participants?: string }>(
    db,
    'SELECT project_key, principal_investigator, participants FROM projects'
  );
  for (const project of projects) {
    if (project.principal_investigator) {
      const personKey = await resolveUpsertEntityInDb(db, 'person', project.principal_investigator);
      if (personKey) {
        await resolveUpsertEdgeInDb(db, project.project_key, personKey, 'hosted_by', 5);
        linked += 1;
      }
    }
  }
  return linked;
}

async function linkInstitutions(db: Database) {
  let linked = 0;
  const mentors = await allInDb<{ mentor_key: string; school?: string; college?: string }>(
    db,
    'SELECT mentor_key, school, college FROM mentor_profiles'
  );
  for (const mentor of mentors) {
    for (const name of [mentor.school, mentor.college].filter(Boolean) as string[]) {
      const key = await resolveUpsertEntityInDb(db, 'institution', name);
      if (key) {
        await resolveUpsertEdgeInDb(db, mentor.mentor_key, key, 'affiliated_with', 4);
        linked += 1;
      }
    }
  }

  const projects = await allInDb<{ project_key: string; institution?: string; partner_institutions?: string }>(
    db,
    'SELECT project_key, institution, partner_institutions FROM projects'
  );
  for (const project of projects) {
    if (project.institution) {
      const key = await resolveUpsertEntityInDb(db, 'institution', project.institution);
      if (key) {
        await resolveUpsertEdgeInDb(db, project.project_key, key, 'undertaken_by', 5);
        linked += 1;
      }
    }
  }
  return linked;
}

async function linkOutputsToPapers(db: Database) {
  let linked = 0;
  const outputs = await allInDb<{ output_key: string; project_key: string; title?: string }>(
    db,
    `SELECT output_key, project_key, title FROM outputs WHERE title IS NOT NULL AND length(trim(title)) > 4`
  );
  const papers = await allInDb<{ paper_key: string; title: string }>(
    db,
    `SELECT paper_key, title FROM paper_documents WHERE title IS NOT NULL AND length(trim(title)) > 4`
  );

  const paperByCanon = new Map<string, Array<{ paper_key: string; title: string }>>();
  for (const paper of papers) {
    const canon = canonicalizeTitle(paper.title);
    if (!canon) continue;
    const list = paperByCanon.get(canon) || [];
    list.push(paper);
    paperByCanon.set(canon, list);
  }

  for (const output of outputs) {
    const canon = canonicalizeTitle(output.title);
    if (!canon) continue;
    const exact = paperByCanon.get(canon);
    if (exact?.length) {
      for (const paper of exact) {
        await resolveUpsertEdgeInDb(db, output.output_key, paper.paper_key, 'produced_paper', 8);
        await resolveUpsertEdgeInDb(db, output.project_key, paper.paper_key, 'produced_paper', 6);
        linked += 1;
      }
      continue;
    }

    // 前缀桶近似匹配
    const prefix = canon.slice(0, Math.min(6, canon.length));
    for (const [paperCanon, list] of paperByCanon) {
      if (!paperCanon.startsWith(prefix) && !prefix.startsWith(paperCanon.slice(0, Math.min(6, paperCanon.length)))) {
        continue;
      }
      for (const paper of list) {
        const score = similarityScore(output.title, paper.title);
        if (score >= 0.92) {
          await resolveUpsertEdgeInDb(db, output.output_key, paper.paper_key, 'produced_paper', Math.round(score * 8));
          await resolveUpsertEdgeInDb(db, output.project_key, paper.paper_key, 'produced_paper', Math.round(score * 6));
          linked += 1;
        }
      }
    }
  }
  return linked;
}

async function linkMentorPersons(db: Database) {
  let linked = 0;
  // 论文作者实体 ↔ 导师 person 实体：若别名指向同一 key 已对齐；否则对同名补边
  const authors = await allInDb<{ entity_key: string; name: string }>(
    db,
    `SELECT DISTINCT e.entity_key, e.name
     FROM entities e
     JOIN edges ed ON ed.target_key = e.entity_key AND ed.relation = 'authored_by'
     WHERE e.type = 'person'
     LIMIT 20000`
  );
  for (const author of authors) {
    const mentor = await getInDb<{ mentor_key: string }>(
      db,
      `SELECT mentor_key FROM mentor_profiles WHERE name = ? LIMIT 1`,
      [author.name]
    );
    if (mentor) {
      await resolveUpsertEdgeInDb(db, mentor.mentor_key, author.entity_key, 'same_as', 7);
      linked += 1;
    }
  }
  return linked;
}

async function reinforceKeywords(db: Database) {
  let linked = 0;
  const keywords = await allInDb<{ entity_key: string; name: string }>(
    db,
    `SELECT entity_key, name FROM entities WHERE type IN ('keyword', 'discipline')`
  );
  const byCanon = new Map<string, string[]>();
  for (const row of keywords) {
    const canon = canonicalizeTitle(row.name) || row.name;
    const list = byCanon.get(canon) || [];
    list.push(row.entity_key);
    byCanon.set(canon, list);
  }
  for (const keys of byCanon.values()) {
    if (keys.length < 2) continue;
    for (let i = 1; i < keys.length; i += 1) {
      await resolveUpsertEdgeInDb(db, keys[0], keys[i], 'same_as', 5);
      linked += 1;
    }
  }
  return linked;
}

export async function crossLinkKnowledgeGraphInDb(db: Database): Promise<CrossLinkResult> {
  const personLinks = await linkPersons(db);
  const institutionLinks = await linkInstitutions(db);
  const outputPaperLinks = await linkOutputsToPapers(db);
  const mentorPersonLinks = await linkMentorPersons(db);
  const keywordLinks = await reinforceKeywords(db);
  const aliases = await rebuildAliasesInDb(db);
  const merge = await autoMergeHighConfidenceInDb(db, 0.97);
  return {
    personLinks,
    institutionLinks,
    outputPaperLinks,
    mentorPersonLinks,
    keywordLinks,
    aliases,
    merge
  };
}

export async function crossLinkKnowledgeGraph() {
  return withTransaction(async (db) => await crossLinkKnowledgeGraphInDb(db), true);
}
