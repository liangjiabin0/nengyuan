const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(process.cwd(), 'storage', 'ragpack', 'active', 'database', 'rag.sqlite');
const db = new Database(dbPath);
db.pragma('busy_timeout = 120000');
const oldP = 'D:\\工作\\电元系统';
const newP = 'D:\\电元系统';

const updates = [
  ['paper_documents', 'file_path'],
  ['paper_documents', 'pdf_path'],
  ['paper_documents', 'original_path'],
  ['mentor_profiles', 'file_path']
];

for (const [table, col] of updates) {
  const before = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} LIKE ?`).get(`${oldP}%`).c;
  if (before > 0) {
    db.prepare(`UPDATE ${table} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ?`).run(oldP, newP, `${oldP}%`);
  }
  const stillOld = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} LIKE ?`).get(`${oldP}%`).c;
  const nowNew = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} LIKE ?`).get(`${newP}%`).c;
  console.log(`${table}.${col}: remapped=${before}, stillOld=${stillOld}, underNew=${nowNew}`);
}

const samples = db
  .prepare(`SELECT pdf_path FROM paper_documents WHERE pdf_path LIKE ? LIMIT 8`)
  .all(`${newP}%`);
let exist = 0;
for (const row of samples) {
  if (row.pdf_path && fs.existsSync(row.pdf_path)) exist += 1;
}
console.log(`sampleExist=${exist}/${samples.length}`);
for (const row of samples.slice(0, 3)) console.log(' ', row.pdf_path);

db.close();
