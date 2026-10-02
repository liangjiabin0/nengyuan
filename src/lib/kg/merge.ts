import type { Database } from '../db';
import { withTransaction } from '../db';
import { hashText } from '../normalize';

async function runInDb(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) await db.prepare(sql).run(...params);
  else await db.prepare(sql).run();
}

async function allInDb<T>(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) return db.prepare(sql).all<T>(...params);
  return db.prepare(sql).all<T>();
}

/** 将 fromKey 的边/别名/mentions 合并到 toKey，并删除 from 实体 */
export async function mergeEntityKeysInDb(db: Database, fromKey: string, toKey: string) {
  if (!fromKey || !toKey || fromKey === toKey) return;

  const fromEdges = await allInDb<{ edge_key: string; source_key: string; target_key: string; relation: string; weight: number; meta?: string }>(
    db,
    'SELECT edge_key, source_key, target_key, relation, weight, meta FROM edges WHERE source_key = ? OR target_key = ?',
    [fromKey, fromKey]
  );

  for (const edge of fromEdges) {
    const source = edge.source_key === fromKey ? toKey : edge.source_key;
    const target = edge.target_key === fromKey ? toKey : edge.target_key;
    if (source === target) {
      await runInDb(db, 'DELETE FROM edges WHERE edge_key = ?', [edge.edge_key]);
      continue;
    }
    const newKey = `edge:${hashText([source, target, edge.relation].join('|')).slice(0, 24)}`;
    await runInDb(
      db,
      `INSERT INTO edges(edge_key, source_key, target_key, relation, weight, meta, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(edge_key) DO UPDATE SET weight=GREATEST(edges.weight, excluded.weight)`,
      [newKey, source, target, edge.relation, edge.weight, edge.meta || '{}']
    );
    await runInDb(db, 'DELETE FROM edges WHERE edge_key = ?', [edge.edge_key]);
  }

  await runInDb(db, 'UPDATE entity_aliases SET entity_key = ? WHERE entity_key = ?', [toKey, fromKey]);
  await runInDb(
    db,
    `INSERT INTO entity_mentions(record_id, entity_key, relation, weight)
     SELECT record_id, ?, relation, weight FROM entity_mentions WHERE entity_key = ?
     ON CONFLICT(record_id, entity_key, relation) DO UPDATE SET weight=entity_mentions.weight + excluded.weight`,
    [toKey, fromKey]
  );
  await runInDb(db, 'DELETE FROM entity_mentions WHERE entity_key = ?', [fromKey]);
  await runInDb(db, 'DELETE FROM entities WHERE entity_key = ?', [fromKey]);
}

export type MergeResult = {
  autoMerged: number;
  pending: number;
  skipped: number;
};

/**
 * 自动合并高置信候选（score >= 0.97），其余保持 pending。
 * 选择「名字更长 / 更早创建」的一侧作为保留键（按 name 长度）。
 */
export async function autoMergeHighConfidenceInDb(db: Database, minScore = 0.97): Promise<MergeResult> {
  const pending = await allInDb<{
    id: number;
    source_type: string;
    source_key: string;
    target_key: string;
    score: number;
  }>(
    db,
    `SELECT id, source_type, source_key, target_key, score
     FROM merge_candidates
     WHERE status = 'pending' AND score >= ?
     ORDER BY score DESC
     LIMIT 5000`,
    [minScore]
  );

  let autoMerged = 0;
  let skipped = 0;

  for (const row of pending) {
    const left = (await allInDb<{ entity_key: string; name: string; type: string }>(
      db,
      'SELECT entity_key, name, type FROM entities WHERE entity_key = ?',
      [row.source_key]
    ))[0];
    const right = (await allInDb<{ entity_key: string; name: string; type: string }>(
      db,
      'SELECT entity_key, name, type FROM entities WHERE entity_key = ?',
      [row.target_key]
    ))[0];

    if (!left || !right || left.type !== right.type) {
      await runInDb(db, `UPDATE merge_candidates SET status = 'skipped' WHERE id = ?`, [row.id]);
      skipped += 1;
      continue;
    }

    const keep = left.name.length >= right.name.length ? left.entity_key : right.entity_key;
    const drop = keep === left.entity_key ? right.entity_key : left.entity_key;
    await mergeEntityKeysInDb(db, drop, keep);
    await runInDb(db, `UPDATE merge_candidates SET status = 'merged' WHERE id = ?`, [row.id]);
    // 同步其它涉及 drop 的候选
    await runInDb(
      db,
      `UPDATE merge_candidates SET status = 'merged'
       WHERE status = 'pending' AND (source_key = ? OR target_key = ?)`,
      [drop, drop]
    );
    autoMerged += 1;
  }

  const stillPending = (await allInDb<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM merge_candidates WHERE status = 'pending'`
  ))[0]?.c;

  return { autoMerged, pending: Number(stillPending || 0), skipped };
}

export async function autoMergeHighConfidence(minScore = 0.97) {
  return withTransaction(async (db) => await autoMergeHighConfidenceInDb(db, minScore), true);
}
