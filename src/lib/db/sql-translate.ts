const REPLACE_CONFLICT: Record<string, string> = {
  paper_chunks: 'chunk_key',
  search_terms: 'term, record_id, field_name'
};

const SERIAL_INSERT_TABLES = new Set([
  'source_files',
  'raw_records',
  'merge_candidates',
  'patent_generation_events',
  'scheme_events',
  'ppt_voice_events',
  'ppt_voice_messages'
]);

export function quoteCamelAliases(sql: string) {
  return sql.replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi, (full, alias: string) => {
    if (/[A-Z]/.test(alias.slice(1))) return `AS "${alias}"`;
    return full;
  });
}

export function translateSql(sql: string): string {
  let text = sql.trim();
  text = text.replace(/\bdatetime\('now'\)/gi, "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')");
  text = text.replace(
    /\bdatetime\('now'\s*,\s*\?\)/gi,
    "to_char(NOW() + CAST(? AS interval), 'YYYY-MM-DD HH24:MI:SS')"
  );
  text = text.replace(/(\b[A-Za-z_][A-Za-z0-9_]*\b)\s*=\s*\?\s*COLLATE\s+NOCASE/gi, 'LOWER($1) = LOWER(?)');
  text = text.replace(/\s+COLLATE\s+NOCASE/gi, '');
  text = text.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  text = text.replace(/\browid\b/gi, 'id');

  text = text.replace(
    /^INSERT\s+OR\s+REPLACE\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)\s*$/i,
    (_full, table: string, cols: string, values: string) => {
      const conflict = REPLACE_CONFLICT[String(table).toLowerCase()];
      const names = cols.split(',').map((item: string) => item.trim()).filter(Boolean);
      if (!conflict) {
        return `INSERT INTO ${table} (${cols}) VALUES (${values})`;
      }
      const updates = names
        .filter((name) => !conflict.split(',').map((part) => part.trim()).includes(name))
        .map((name) => `${name}=EXCLUDED.${name}`)
        .join(', ');
      return `INSERT INTO ${table} (${cols}) VALUES (${values}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`;
    }
  );

  text = quoteCamelAliases(text);

  const insertMatch = text.match(/^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i);
  if (insertMatch && !/\bRETURNING\b/i.test(text)) {
    const table = insertMatch[1].toLowerCase();
    if (SERIAL_INSERT_TABLES.has(table)) {
      text = `${text} RETURNING id`;
    }
  }

  return text;
}

export function toPgParams(sql: string, params: unknown[]): { text: string; values: unknown[] } {
  const translated = translateSql(sql);
  let index = 0;
  const text = translated.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
  if (index !== params.length) {
    // allow extra unused params only when SQL had no placeholders
    if (index === 0 && params.length === 0) return { text, values: [] };
    if (index !== params.length) {
      throw new Error(`SQL placeholder count ${index} != params ${params.length}: ${sql.slice(0, 180)}`);
    }
  }
  return { text, values: params };
}
