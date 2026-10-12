// 修复自增主键序列落后于表内最大 id 的问题。
// 症状：新增记录时报 “重复键违反唯一约束 "xxx_pkey"”（例如专利生成上传文档时的 patent_generation_events_pkey）。
// 原因：数据从 SQLite / 备份导入时带着原 id 写入，PostgreSQL 的序列没有跟着前移。
//
// 用法（在项目根目录，读取 .env.local 的 DATABASE_URL）：
//   node scripts/fix-identity-sequences.mjs          # 只检查，不修改
//   node scripts/fix-identity-sequences.mjs --apply  # 把落后的序列移到 max(id) 之后
// 只会把序列往前移，不会改动任何表数据，可以重复运行。
import fs from 'node:fs';
import pg from 'pg';

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8') : '';
  const url = env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
  if (!url) throw new Error('找不到 DATABASE_URL（环境变量或 .env.local）');
  return url;
}

const apply = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: databaseUrl() });

try {
  const { rows: columns } = await pool.query(`
    SELECT c.table_name, c.column_name,
           pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS seq
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND (c.is_identity = 'YES' OR c.column_default LIKE 'nextval%')
    ORDER BY c.table_name`);
  let behind = 0;
  for (const { table_name: table, column_name: column, seq } of columns) {
    if (!seq) continue;
    const max = Number((await pool.query(`SELECT COALESCE(MAX(${pg.escapeIdentifier(column)}), 0)::bigint AS m FROM ${pg.escapeIdentifier(table)}`)).rows[0].m);
    const state = (await pool.query(`SELECT last_value, is_called FROM ${seq}`)).rows[0];
    const next = state.is_called ? Number(state.last_value) + 1 : Number(state.last_value);
    if (next > max) continue;
    behind += 1;
    if (apply) {
      // setval(seq, max, true) 之后下一个值是 max + 1
      await pool.query('SELECT setval($1, $2, true)', [seq, max]);
      console.log(`已修复 ${table}.${column}: 下一个 id ${next} -> ${max + 1}`);
    } else {
      console.log(`落后 ${table}.${column}: 表内最大 ${max}，下一个 id 却是 ${next}`);
    }
  }
  if (!behind) console.log('所有自增序列正常。');
  else if (!apply) console.log(`共 ${behind} 个序列落后。加 --apply 修复。`);
} finally {
  await pool.end();
}
