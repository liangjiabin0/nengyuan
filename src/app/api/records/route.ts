import { NextResponse } from 'next/server';
import { all, getColumns, invalidateDbCaches, withTransaction } from '@/lib/db';
import { rebuildSearchIndex } from '@/lib/search-index';
import { exportKnowledgeCorpus } from '@/lib/corpus/export';
import { requireAdmin, requireUser } from '@/lib/auth/request';

const TABLE_CONFIG = {
  source_files: {
    primaryKey: 'id',
    display: ['id', 'filename', 'sheet_name', 'row_count', 'imported_at', 'status']
  },
  raw_records: {
    primaryKey: 'id',
    display: ['id', 'source_file_id', 'row_index', 'project_key', 'payload', 'created_at']
  },
  projects: {
    primaryKey: 'project_key',
    display: ['project_key', 'project_name', 'institution', 'principal_investigator', 'year', 'keywords', 'updated_at']
  },
  outputs: {
    primaryKey: 'output_key',
    display: ['output_key', 'project_key', 'title', 'publication', 'authors', 'updated_at']
  },
  entities: {
    primaryKey: 'entity_key',
    display: ['entity_key', 'type', 'name', 'meta', 'updated_at']
  },
  edges: {
    primaryKey: 'edge_key',
    display: ['edge_key', 'source_key', 'target_key', 'relation', 'weight', 'updated_at']
  }
} as const;

type TableName = keyof typeof TABLE_CONFIG;

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function getTableMeta(table: TableName) {
  const columns = (await getColumns(table)).map((column) => column.name);
  return {
    columns,
    primaryKey: TABLE_CONFIG[table].primaryKey,
    displayColumns: TABLE_CONFIG[table].display.filter((column) => columns.includes(column))
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { searchParams } = new URL(request.url);
  const table = (searchParams.get('table') || 'projects') as TableName;
  if (!(table in TABLE_CONFIG)) return jsonError('不支持的数据表。');

  const query = (searchParams.get('q') || '').trim();
  const page = Math.max(1, Number(searchParams.get('page') || '1'));
  const pageSize = Math.min(100, Math.max(5, Number(searchParams.get('pageSize') || '20')));
  const offset = (page - 1) * pageSize;
  const meta = await getTableMeta(table);
  const searchableColumns = meta.columns.filter((column) => column !== 'payload' || table === 'raw_records');

  const params: unknown[] = [];
  let whereClause = '';
  if (query && searchableColumns.length) {
    whereClause = `WHERE ${searchableColumns.map((column) => `CAST(${quoteIdentifier(column)} AS TEXT) LIKE ?`).join(' OR ')}`;
    params.push(...searchableColumns.map(() => `%${query}%`));
  }

  const rows = await all(
    `SELECT * FROM ${quoteIdentifier(table)} ${whereClause} ORDER BY ${quoteIdentifier(meta.primaryKey)} DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const total = Number(
    (await all<{ total: number }>(`SELECT COUNT(*) as total FROM ${quoteIdentifier(table)} ${whereClause}`, params))[0]?.total || 0
  );

  return NextResponse.json({
    rows,
    total,
    page,
    pageSize,
    columns: meta.columns,
    displayColumns: meta.displayColumns,
    primaryKey: meta.primaryKey
  });
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null);
  const table = String(body?.table || '') as TableName;
  if (!(table in TABLE_CONFIG)) return jsonError('不支持的数据表。');

  const id = body?.id;
  const values = body?.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : null;
  if (id == null || !values) return jsonError('缺少更新参数。');

  const meta = await getTableMeta(table);
  const updates = Object.entries(values).filter(([column]) => column !== meta.primaryKey && meta.columns.includes(column));
  if (!updates.length) return jsonError('没有可更新字段。');

  await withTransaction(async (database) => {
    const sql = `UPDATE ${quoteIdentifier(table)} SET ${updates.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE ${quoteIdentifier(meta.primaryKey)} = ?`;
    await database.prepare(sql).run(...updates.map(([, value]) => value ?? null), id);
  }, true);

  await rebuildSearchIndex();
  await exportKnowledgeCorpus();
  invalidateDbCaches();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null);
  const table = String(body?.table || '') as TableName;
  if (!(table in TABLE_CONFIG)) return jsonError('不支持的数据表。');

  const id = body?.id;
  if (id == null) return jsonError('缺少删除参数。');

  const meta = await getTableMeta(table);
  await withTransaction(async (database) => {
    await database
      .prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(meta.primaryKey)} = ?`)
      .run(id);
  }, true);

  await rebuildSearchIndex();
  await exportKnowledgeCorpus();
  invalidateDbCaches();
  return NextResponse.json({ ok: true });
}
