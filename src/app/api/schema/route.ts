import { NextResponse } from 'next/server';
import { getColumns, listTables } from '@/lib/db';
import { requireUser } from '@/lib/auth/request';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const tables = await listTables();
  return NextResponse.json({
    tables: await Promise.all(
      tables.map(async (table) => ({
        name: table.name,
        columns: await getColumns(table.name)
      }))
    )
  });
}
