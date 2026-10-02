const Database = require('better-sqlite3');
const db = new Database('storage/ragpack/active/database/rag.sqlite', { readonly: true });
const papers = db.prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key NOT LIKE 'patent:%'").get().c;
const mentors = db.prepare('SELECT COUNT(*) AS c FROM mentor_profiles').get().c;
const patents = db.prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'patent:%'").get().c;
console.log(JSON.stringify({ papers, patents, mentors }, null, 2));
db.close();
