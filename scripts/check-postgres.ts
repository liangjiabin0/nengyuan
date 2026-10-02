// 【按线上版本补回】依据线上 dist/runtime/check-postgres-app.mjs 还原：检查数据库能否连上。
import { Pool } from 'pg';
import { getDatabaseUrl } from '../src/lib/db/pg-database';
import { loadProjectEnv } from '../src/lib/load-env';

async function main() {
  loadProjectEnv();
  const url = getDatabaseUrl();
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    await pool.query('SELECT 1 AS ok');
    console.log(`[postgres] ok ${url.replace(/:[^:@/]+@/, ':***@')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[postgres] 连不上数据库：${message}`);
    console.error('请安装 PostgreSQL 16，创建角色/库 ai4es，并在 .env.local 设置 DATABASE_URL。');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
