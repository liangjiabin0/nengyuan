import type { Database } from '../db';
import { withTransaction } from '../db';
import { similarityScore } from '../text';
import { aliasVariantsForType, canonicalizeByType } from './canonicalize';
import { insertMergeCandidate, upsertAliasResolved } from './entity-resolve';
import { autoMergeHighConfidenceInDb } from './merge';

async function allInDb<T>(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) return db.prepare(sql).all<T>(...params);
  return db.prepare(sql).all<T>();
}

export type RebuildAliasesResult = {
  entitiesScanned: number;
  aliasesWritten: number;
  candidatesAdded: number;
  autoMerged: number;
};

/**
 * 全库重建别名，并在同类型内按规范化名/高相似生成 merge_candidates，再自动合并高置信项。
 */
export async function rebuildAliasesInDb(db: Database): Promise<RebuildAliasesResult> {
  const entities = await allInDb<{ entity_key: string; type: string; name: string }>(
    db,
    'SELECT entity_key, type, name FROM entities'
  );

  let aliasesWritten = 0;
  const byType = new Map<string, Array<{ entity_key: string; name: string; canon: string }>>();

  for (const entity of entities) {
    const canon = canonicalizeByType(entity.type, entity.name);
    for (const variant of aliasVariantsForType(entity.type, entity.name)) {
      await upsertAliasResolved(db, variant, entity.entity_key, entity.type, 1);
      aliasesWritten += 1;
    }
    const list = byType.get(entity.type) || [];
    list.push({ entity_key: entity.entity_key, name: entity.name, canon });
    byType.set(entity.type, list);
  }

  let candidatesAdded = 0;
  for (const [type, list] of byType) {
    const canonMap = new Map<string, Array<{ entity_key: string; name: string }>>();
    for (const item of list) {
      if (!item.canon) continue;
      const group = canonMap.get(item.canon) || [];
      group.push({ entity_key: item.entity_key, name: item.name });
      canonMap.set(item.canon, group);
    }

    for (const [canon, group] of canonMap) {
      if (group.length < 2) continue;
      const keep = group[0];
      for (let i = 1; i < group.length; i += 1) {
        await insertMergeCandidate(db, type, keep.entity_key, group[i].entity_key, 1, `same_canon:${canon}`);
        candidatesAdded += 1;
      }
    }

    // 对人名/机构做有限的两两相似（按前缀分桶）
    if ((type === 'person' || type === 'institution') && list.length > 1 && list.length < 12000) {
      const buckets = new Map<string, typeof list>();
      for (const item of list) {
        const prefix = (item.canon || item.name).slice(0, 2);
        const bucket = buckets.get(prefix) || [];
        bucket.push(item);
        buckets.set(prefix, bucket);
      }
      for (const bucket of buckets.values()) {
        for (let i = 0; i < bucket.length; i += 1) {
          for (let j = i + 1; j < Math.min(bucket.length, i + 12); j += 1) {
            const score = similarityScore(bucket[i].name, bucket[j].name);
            if (score >= 0.92) {
              await insertMergeCandidate(
                db,
                type,
                bucket[i].entity_key,
                bucket[j].entity_key,
                score,
                `rebuild_similarity:${score.toFixed(3)}`
              );
              candidatesAdded += 1;
            }
          }
        }
      }
    }
  }

  const merge = await autoMergeHighConfidenceInDb(db, 0.97);
  return {
    entitiesScanned: entities.length,
    aliasesWritten,
    candidatesAdded,
    autoMerged: merge.autoMerged
  };
}

export async function rebuildAliases() {
  return withTransaction(async (db) => await rebuildAliasesInDb(db), true);
}
