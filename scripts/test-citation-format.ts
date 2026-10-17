import assert from 'node:assert/strict';
import path from 'node:path';
import {
  linkifyOpenCodeCitations,
  normalizeCitationPath,
  parsePathCitationId,
  rewriteAllCitationsToLabels,
  rewritePathCitationsToLabels
} from '../src/lib/opencode/citation-format';
import {
  extractOpenCodeCitations,
  resolveCitationFile,
  resolveOpenCodeCitations
} from '../src/lib/opencode/citations';
import { finalAnswerFromParts } from '../src/lib/opencode/runtime';
import type { Part } from '@opencode-ai/sdk/v2';

const mentorPath = 'knowledge-corpus/mentors/02206e0b9892c92df9d3c10a.md';
const content = `巨云涛是导师。[${mentorPath}:144] 另见 [E2]。`;
const pathOnly = `专利见 [knowledge-corpus/patents/02e8773d0060b211c9593efb.md]。`;

assert.equal(
  rewritePathCitationsToLabels(content, [
    {
      id: 'E1',
      corpusPath: 'mentors/02206e0b9892c92df9d3c10a.md',
      pathAliases: ['mentors/02206e0b9892c92df9d3c10a.md', '02206e0b9892c92df9d3c10a.md'],
      matchReason: '能元 Markdown 引用 mentors/02206e0b9892c92df9d3c10a.md:144-144'
    },
    { id: 'E2', corpusPath: 'papers/aaaaaaaaaaaaaaaaaaaaaaaa.md' }
  ]),
  '巨云涛是导师。[E1] 另见 [E2]。'
);

assert.equal(
  rewritePathCitationsToLabels(pathOnly, [
    {
      id: 'E1',
      corpusPath: 'patents/02e8773d0060b211c9593efb.md',
      pathAliases: ['patents/02e8773d0060b211c9593efb.md']
    }
  ]),
  '专利见 [E1]。'
);

const linked = linkifyOpenCodeCitations(content, [
  {
    id: 'E1',
    corpusPath: 'mentors/02206e0b9892c92df9d3c10a.md',
    pathAliases: ['mentors/02206e0b9892c92df9d3c10a.md'],
    matchReason: '能元 Markdown 引用 mentors/02206e0b9892c92df9d3c10a.md:144-144'
  },
  { id: 'E2', corpusPath: 'papers/aaaaaaaaaaaaaaaaaaaaaaaa.md' }
]);
assert.match(linked, /\[E1\]\(#cite-E1\)/);
assert.match(linked, /\[E2\]\(#cite-E2\)/);
assert.doesNotMatch(linked, /02206e0b9892c92df9d3c10a\.md:144/);
assert.equal(normalizeCitationPath(mentorPath), 'mentors/02206e0b9892c92df9d3c10a.md');
assert.deepEqual(parsePathCitationId('path:mentors/x.md:10-12'), {
  path: 'mentors/x.md',
  startLine: Number(10),
  endLine: Number(12)
});

// Unresolved path brackets must disappear (never show raw paths).
assert.equal(
  rewritePathCitationsToLabels('结论。[patents/does-not-exist-zzzz.md:9]完', []),
  '结论。完'
);
assert.doesNotMatch(
  linkifyOpenCodeCitations('结论。[patents/does-not-exist-zzzz.md:9]', []),
  /does-not-exist|SOURCE\.md|patents\//
);

// Patent workspace: with/without opencode, plus workingDirectory-relative form.
const patentId = '1c1759ee-8f3b-49dd-9063-5548dba41a85';
const patentCite = `[patents/${patentId}/SOURCE.md:1346-1347]`;
const patentCites = extractOpenCodeCitations(patentCite);
assert.equal(patentCites.length, 1);
const patentResolved = resolveOpenCodeCitations(patentCites);
assert.equal(patentResolved.invalid.length, 0, String(patentResolved.invalid));
assert.equal(patentResolved.sources[0]?.id, 'E1');
assert.equal(rewriteAllCitationsToLabels(patentCite, patentResolved.sources), '[E1]');
assert.match(
  linkifyOpenCodeCitations(patentCite, patentResolved.sources),
  /\[E1\]\(#cite-E1\)/
);

const patentWithOpen = `[patents/${patentId}/opencode/SOURCE.md:1346-1347]`;
assert.equal(
  rewriteAllCitationsToLabels(
    patentWithOpen,
    resolveOpenCodeCitations(extractOpenCodeCitations(patentWithOpen)).sources
  ),
  '[E1]'
);

const workDir = path.join(process.cwd(), 'storage', 'patents', patentId);
const relativeCite = '[opencode/SOURCE.md:1346-1347]';
const relativeResolved = resolveOpenCodeCitations(extractOpenCodeCitations(relativeCite), {
  workingDirectory: workDir
});
assert.equal(relativeResolved.invalid.length, 0, String(relativeResolved.invalid));
assert.equal(rewriteAllCitationsToLabels(relativeCite, relativeResolved.sources), '[E1]');

// Project file with out-of-range line still becomes E#.
const projectCite = '[projects/534c1259601745b4d7292c2b.md:39]';
const projectResolved = resolveOpenCodeCitations(extractOpenCodeCitations(projectCite));
assert.equal(projectResolved.invalid.length, 0, String(projectResolved.invalid));
assert.equal(rewriteAllCitationsToLabels(projectCite, projectResolved.sources), '[E1]');

// Bare hash filename extracts and resolves via domain search when file exists.
const bareHashHit = resolveCitationFile('534c1259601745b4d7292c2b.md');
assert.ok(bareHashHit, 'bare hash should resolve under projects/');

// Markdown links must not be eaten by path citation regex.
assert.equal(
  rewritePathCitationsToLabels('[说明](https://example.com/a.md)', []),
  '[说明](https://example.com/a.md)'
);

const parts = [
  { type: 'text', text: '先查档案', id: 't1', sessionID: 's', messageID: 'm' },
  {
    type: 'tool',
    id: 'tool1',
    sessionID: 's',
    messageID: 'm',
    callID: 'c1',
    tool: 'read',
    state: {
      status: 'completed',
      input: {},
      output: 'ok',
      title: '',
      metadata: {},
      time: { start: 1, end: 2 }
    }
  },
  {
    type: 'text',
    text: '结论：巨云涛为相关导师。[knowledge-corpus/mentors/02206e0b9892c92df9d3c10a.md:144]',
    id: 't2',
    sessionID: 's',
    messageID: 'm'
  }
] as Part[];

assert.equal(
  finalAnswerFromParts(parts),
  '结论：巨云涛为相关导师。[knowledge-corpus/mentors/02206e0b9892c92df9d3c10a.md:144]'
);

console.log('citation-format + final-answer ok');
