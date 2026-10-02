import type { Database } from '../db';
import { entityKey, hashText } from '../normalize';
import { similarityScore } from '../text';
import { aliasVariantsForType, canonicalizeByType, cleanDisplayName } from './canonicalize';
import { isMeaningfulTermName, normalizeTermName } from './term-quality';

async function runInDb(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) await db.prepare(sql).run(...params);
  else await db.prepare(sql).run();
}

async function getInDb<T>(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) return db.prepare(sql).get<T>(...params);
  return db.prepare(sql).get<T>();
}

async function allInDb<T>(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) return db.prepare(sql).all<T>(...params);
  return db.prepare(sql).all<T>();
}

export async function upsertAliasResolved(
  db: Database,
  alias: string,
  entityKeyValue: string,
  type: string,
  confidence = 1
) {
  const normalized = canonicalizeByType(type, alias) || alias;
  if (!normalized) return;
  await runInDb(
    db,
    `INSERT INTO entity_aliases(normalized_alias, alias, entity_key, type, confidence, source_count, updated_at)
     VALUES(?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(normalized_alias, type) DO UPDATE SET
       entity_key=CASE
         WHEN excluded.confidence >= entity_aliases.confidence THEN excluded.entity_key
         ELSE entity_aliases.entity_key
       END,
       alias=excluded.alias,
       confidence=GREATEST(entity_aliases.confidence, excluded.confidence),
       source_count=entity_aliases.source_count + 1,
       updated_at=CURRENT_TIMESTAMP`,
    [normalized, cleanDisplayName(alias) || alias, entityKeyValue, type, confidence]
  );
}

export async function findEntityByAlias(db: Database, type: string, name: string) {
  const variants = aliasVariantsForType(type, name);
  for (const variant of variants) {
    const normalized = canonicalizeByType(type, variant) || variant;
    const hit = await getInDb<{ entity_key: string; name?: string }>(
      db,
      `SELECT ea.entity_key, e.name
       FROM entity_aliases ea
       LEFT JOIN entities e ON e.entity_key = ea.entity_key
       WHERE ea.normalized_alias = ? AND ea.type = ?
       LIMIT 1`,
      [normalized, type]
    );
    if (hit?.entity_key) return hit;
  }
  return null;
}

export async function insertMergeCandidate(
  db: Database,
  sourceType: string,
  sourceKey: string,
  targetKey: string,
  score: number,
  reason: string
) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  try {
    await runInDb(
      db,
      `INSERT INTO merge_candidates(source_type, source_key, target_key, score, reason, status)
       VALUES(?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(source_type, source_key, target_key) DO UPDATE SET
         score=GREATEST(merge_candidates.score, excluded.score),
         reason=excluded.reason`,
      [sourceType, sourceKey, targetKey, score, reason]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/23505|unique|重复键/i.test(message)) throw error;
  }
}

/** 在同类型实体中找高相似候选（限制扫描量） */
async function findSimilarEntities(db: Database, type: string, name: string, limit = 8) {
  const display = cleanDisplayName(name);
  if (!display || display.length < 2) return [] as Array<{ entity_key: string; name: string; score: number }>;

  const prefix = display.slice(0, Math.min(2, display.length));
  const rows = await allInDb<{ entity_key: string; name: string }>(
    db,
    `SELECT entity_key, name FROM entities
     WHERE type = ? AND (name LIKE ? OR name LIKE ?)
     LIMIT 40`,
    [type, `${prefix}%`, `%${display.slice(0, Math.min(4, display.length))}%`]
  );

  return rows
    .map((row) => ({
      entity_key: row.entity_key,
      name: row.name,
      score: similarityScore(display, row.name)
    }))
    .filter((row) => row.score >= 0.88 && row.entity_key)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 统一实体写入：别名命中复用 key；否则新建并登记别名；高相似写入 merge_candidates。
 */
export async function resolveUpsertEntityInDb(
  db: Database,
  type: string,
  name?: string,
  meta: Record<string, unknown> = {}
) {
  const cleaned = cleanDisplayName(name);
  const isTerm = type === 'keyword' || type === 'algorithm' || type === 'discipline';
  const display = isTerm ? normalizeTermName(cleaned) : cleaned;
  if (!display) return null;
  if (isTerm && !isMeaningfulTermName(display, type)) return null;

  const aliasHit = await findEntityByAlias(db, type, display);
  const key = aliasHit?.entity_key || entityKey(type, canonicalizeByType(type, display) || display);

  const existingMeta = await getInDb<{ meta?: string }>(db, 'SELECT meta FROM entities WHERE entity_key = ?', [key]);
  let mergedMeta = meta;
  if (existingMeta?.meta) {
    try {
      mergedMeta = { ...(JSON.parse(existingMeta.meta) as Record<string, unknown>), ...meta };
    } catch {
      mergedMeta = meta;
    }
  }

  await runInDb(
    db,
    `INSERT INTO entities(entity_key, type, name, meta, updated_at)
     VALUES(?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(entity_key) DO UPDATE SET
       name=CASE WHEN length(excluded.name) >= length(entities.name) THEN excluded.name ELSE entities.name END,
       meta=excluded.meta,
       updated_at=CURRENT_TIMESTAMP`,
    [key, type, display, JSON.stringify(mergedMeta)]
  );

  for (const variant of aliasVariantsForType(type, display)) {
    await upsertAliasResolved(db, variant, key, type, 1);
  }

  if (!aliasHit) {
    for (const similar of await findSimilarEntities(db, type, display)) {
      if (similar.entity_key === key) continue;
      await insertMergeCandidate(db, type, key, similar.entity_key, similar.score, `name_similarity:${similar.score.toFixed(3)}`);
      if (similar.score >= 0.97) {
        await upsertAliasResolved(db, display, similar.entity_key, type, similar.score);
      }
    }
  }

  return key;
}

export async function resolveUpsertEdgeInDb(
  db: Database,
  source: string | null,
  target: string | null,
  relation: string,
  weight = 1,
  meta: Record<string, unknown> = {}
) {
  if (!source || !target || source === target) return;
  const key = `edge:${hashText([source, target, relation].join('|')).slice(0, 24)}`;
  await runInDb(
    db,
    `INSERT INTO edges(edge_key, source_key, target_key, relation, weight, meta, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(edge_key) DO UPDATE SET
       weight=GREATEST(edges.weight, excluded.weight),
       meta=excluded.meta,
       updated_at=CURRENT_TIMESTAMP`,
    [key, source, target, relation, weight, JSON.stringify(meta)]
  );
}
