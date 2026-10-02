import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDb } from '../src/lib/db';
import {
  CORPUS_KINDS,
  corpusDirectory,
  getCorpusRoot,
  type CorpusKind
} from '../src/lib/corpus/schema';
import { normalizeFormulaSyntax, wrapLongMarkdownLines } from '../src/lib/corpus/export';
import { CorpusGuard } from '../.opencode/plugins/corpus-guard';

function parseScalar(value: string) {
  const text = value.trim();
  if (text === 'null') return '';
  try {
    return String(JSON.parse(text));
  } catch {
    return text;
  }
}

function parseFrontmatter(filePath: string) {
  const text = fs.readFileSync(filePath, 'utf8');
  const fields: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  assert.equal(lines[0], '---', `${filePath} must start with frontmatter`);
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') break;
    const match = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(lines[index]);
    if (match) fields[match[1]] = parseScalar(match[2]);
  }
  return { text, fields };
}

function manifestCounts(root: string) {
  const text = fs.readFileSync(path.join(root, 'MANIFEST.md'), 'utf8');
  const result = {} as Record<CorpusKind, number>;
  for (const kind of CORPUS_KINDS) {
    const match = new RegExp(`^- \\*\\*${kind}:\\*\\* (\\d+)$`, 'm').exec(text);
    assert.ok(match, `manifest count missing for ${kind}`);
    result[kind] = Number(match[1]);
  }
  return result;
}

function filesFor(root: string, kind: CorpusKind) {
  const dir = path.join(root, corpusDirectory(kind));
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^[a-f0-9]{24}\.md$/.test(name))
    : [];
}

function rgExecutable() {
  const cursorRg = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs',
    'cursor',
    'resources',
    'app',
    'node_modules',
    '@vscode',
    'ripgrep',
    'bin',
    'rg.exe'
  );
  return fs.existsSync(cursorRg) ? cursorRg : 'rg';
}

function ripgrepCount(pattern: string, dir: string) {
  const output = execFileSync(
    rgExecutable(),
    ['--count-matches', '--no-filename', '--glob', '*.md', pattern, dir],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  return output
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter(Number.isFinite)
    .reduce((sum, count) => sum + count, 0);
}

async function main() {
  assert.equal(
    normalizeFormulaSyntax('V₁ = 10, x² ≥ 4, √y'),
    '$V_{1}$ = 10, $x^{2}$ ≥ 4, $\\sqrt{y}$',
    'Unicode formula notation must become LaTeX inside Markdown'
  );
  assert.ok(
    wrapLongMarkdownLines('长'.repeat(600)).split('\n').every((line) => line.length <= 240),
    'long OCR lines must be wrapped before grep'
  );
  const root = getCorpusRoot();
  for (const legacyPath of [
    'src/lib/kernel/agent-loop.ts',
    'src/lib/kernel/query-compiler.ts',
    'src/lib/tools/registry.ts',
    'src/lib/agent/orchestrator.ts',
    'src/lib/langchain/pipeline.ts',
    'src/lib/embedding.ts',
    'src/lib/chat-context.ts'
  ]) {
    assert.equal(fs.existsSync(path.join(process.cwd(), legacyPath)), false, `legacy chat runtime still exists: ${legacyPath}`);
  }
  const primaryChatPath = [
    fs.readFileSync(path.join(process.cwd(), 'src/app/api/chat/route.ts'), 'utf8'),
    fs.readFileSync(path.join(process.cwd(), 'src/lib/opencode/chat.ts'), 'utf8'),
    fs.readFileSync(path.join(process.cwd(), 'src/lib/opencode/runtime.ts'), 'utf8')
  ].join('\n');
  assert.match(primaryChatPath, /runOpenCodeQuestion/);
  assert.match(primaryChatPath, /onTextDelta/);
  assert.doesNotMatch(primaryChatPath, /answer-finalizer|parseEnvelope|finalizationPrompt|chunksFromText/);
  assert.equal(
    fs.existsSync(path.join(process.cwd(), '.opencode/agents/answer-finalizer.md')),
    false,
    'application-owned finalizer agent must be deleted'
  );
  assert.doesNotMatch(primaryChatPath, /query-compiler|langchain|searchRecords|mentorRetrieve|paperRetrieve/);
  assert.ok(fs.existsSync(path.join(root, 'MANIFEST.md')), 'corpus manifest must exist');
  const manifest = manifestCounts(root);
  const db = getDb();
  const expected = {
    mentor: 0,
    person: Number((db.prepare("SELECT COUNT(*) AS c FROM entities WHERE type='person'").get() as { c: number }).c),
    paper: Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key NOT LIKE 'patent:%' AND paper_key NOT LIKE 'whitepaper:%'"
          )
          .get() as { c: number }
      ).c
    ),
    patent: Number((db.prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'patent:%'").get() as { c: number }).c),
    whitepaper: Number(
      (db.prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'whitepaper:%'").get() as { c: number }).c
    ),
    project: Number(
      (db.prepare("SELECT COUNT(*) AS c FROM projects WHERE project_key NOT LIKE 'nkrd:%'").get() as { c: number }).c
    ),
    nkrd: Number((db.prepare("SELECT COUNT(*) AS c FROM projects WHERE project_key LIKE 'nkrd:%'").get() as { c: number }).c),
    // outputs are embedded into project/nkrd Markdown; corpus/outputs stays empty
    output: 0
  } satisfies Record<CorpusKind, number>;

  let totalFiles = 0;
  for (const kind of CORPUS_KINDS) {
    const files = filesFor(root, kind);
    totalFiles += files.length;
    assert.equal(manifest[kind], expected[kind], `${kind} manifest must match SQLite`);
    assert.equal(files.length, expected[kind], `${kind} file count must match SQLite`);
    const sampleIndexes = files.length
      ? [...new Set([0, Math.floor(files.length / 2), files.length - 1])].filter((index) => index >= 0)
      : [];
    for (const index of sampleIndexes) {
      const { fields } = parseFrontmatter(path.join(root, corpusDirectory(kind), files[index]));
      assert.equal(fields.kind, kind);
      assert.ok(fields.record_key, `${kind} sample must have record_key`);
      assert.match(fields.content_hash, /^[a-f0-9]{64}$/);
    }
    if (expected[kind] > 0) {
      assert.equal(
        ripgrepCount(`^kind: "${kind}"$`, path.join(root, corpusDirectory(kind))),
        expected[kind],
        `ripgrep must be able to scan every ${kind} Markdown file`
      );
    }
  }

  const texFiles: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.tex')) texFiles.push(entry.name);
  }
  assert.equal(texFiles.length, 0, 'corpus must not duplicate records as .tex files');

  const mentorDir = path.join(root, 'mentors');
  assert.equal(fs.existsSync(mentorDir), false, 'local mentors corpus must be disabled');

  const paperDir = path.join(root, 'papers');
  const juMatches = execFileSync(
    rgExecutable(),
    ['--files-with-matches', '--glob', '*.md', '巨云涛', paperDir],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  ).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(juMatches.length > 0, '巨云涛 must be discoverable in paper Markdown');
  assert.ok(
    juMatches.some((file) => fs.readFileSync(file, 'utf8').includes('## References')),
    '巨云涛 matches must retain reference sections'
  );

  const guard = await CorpusGuard({ directory: path.dirname(root) });
  const before = guard['tool.execute.before'];
  await before(
    { tool: 'read' },
    { args: { filePath: 'knowledge-corpus/MANIFEST.md' } }
  );
  await assert.rejects(
    before(
      { tool: 'grep' },
      { args: { path: 'knowledge-corpus/mentors', pattern: '^school: "清华大学"$' } }
    ),
    /web_search|已停用/
  );
  await before(
    { tool: 'grep' },
    { args: { path: 'knowledge-corpus/papers', pattern: '巨云涛' } }
  );
  await assert.rejects(
    before(
      { tool: 'bash' },
      {
        args: {
          command: 'rg --stats --count-matches --no-filename --glob "*.md" \'^school: \\x22清华大学\\x22$\' knowledge-corpus/mentors'
        }
      }
    ),
    /web_search|已停用/
  );
  await before(
    { tool: 'bash' },
    {
      args: {
        command: 'rg --files-with-matches "巨云涛" knowledge-corpus/papers'
      }
    }
  );
  await assert.rejects(
    before({ tool: 'grep' }, { args: { path: 'knowledge-corpus', pattern: '巨云涛' } }),
    /knowledge-corpus 根目录/
  );
  await assert.rejects(
    before(
      { tool: 'bash' },
      { args: { command: "rg -n '巨云涛' knowledge-corpus/papers/0b1f9beb38d759ad72387343.md" } }
    ),
    /内置 grep/
  );
  await assert.rejects(
    before({ tool: 'read' }, { args: { filePath: '../settings.json' } }),
    /目录之外/
  );
  await assert.rejects(
    before({ tool: 'bash' }, { args: { command: 'rg 巨云涛 knowledge-corpus/papers; whoami' } }),
    /shell 运算符/
  );
  await assert.rejects(
    before({ tool: 'bash' }, { args: { command: 'type knowledge-corpus/MANIFEST.md' } }),
    /只允许执行 ripgrep/
  );

  console.log(JSON.stringify({
    ok: true,
    totalFiles,
    counts: expected,
    mentorsLocalDisabled: true,
    juYuntaoPaperFiles: juMatches.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
