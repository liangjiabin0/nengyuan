/**
 * Full patent E2E with the desktop PDF.
 * - Creates project from PDF
 * - Runs pipeline; on needs_input answers all questions with 「是」
 *   (identity: treat 「是」 as confirming META candidates)
 * - Continues until completed / review_required / failed / max rounds
 *
 * Usage: npx tsx scripts/e2e-patent-yes-full.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { runPatentPipeline } from '../src/lib/patent-generation/pipeline';
import { parsePatentSource } from '../src/lib/patent-generation/source-parser';
import {
  createPatentProject,
  getPatentProject,
  updatePatentProject
} from '../src/lib/patent-generation/store';
import { readPatentWorkspaceJson } from '../src/lib/opencode/patent';

const sourcePath =
  process.env.PATENT_TEST_PDF
  || 'C:\\Users\\Lenovo\\Desktop\\计及算力负载时空特性的算电热系统优化调度2.0.pdf';

const MAX_ROUNDS = 8;
const YES = '是';

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function answerYesForProject(projectId: string) {
  const project = getPatentProject(projectId);
  if (!project) throw new Error('project missing');
  const meta = readPatentWorkspaceJson<{
    applicantCandidate?: string;
    inventorCandidates?: string[];
  }>(projectId, 'META.json');

  const open = project.blockers.filter((b) => !b.resolved);
  const answers: Record<string, string> = { ...project.answers };
  let applicant = project.applicant;
  let inventors = [...(project.inventors || [])];

  for (const blocker of open) {
    if (blocker.id === 'confirm-applicant') {
      const candidate = meta?.applicantCandidate?.trim()
        || blocker.answer?.trim()
        || extractApplicantFromQuestion(blocker.question)
        || '北方工业大学';
      applicant = candidate;
      answers[blocker.id] = YES;
      log('answer applicant =', candidate, '(via 是)');
      continue;
    }
    if (blocker.id === 'confirm-inventors') {
      const candidates = (meta?.inventorCandidates || []).filter(Boolean);
      const fromAnswer = (blocker.answer || '')
        .split(/[、，,;]/)
        .map((item) => item.trim())
        .filter(Boolean);
      inventors = candidates.length ? candidates : (fromAnswer.length ? fromAnswer : inventors);
      if (!inventors.length) {
        inventors = extractInventorsFromQuestion(blocker.question);
      }
      answers[blocker.id] = YES;
      log('answer inventors =', inventors.join('、'), '(via 是)');
      continue;
    }
    answers[blocker.id] = YES;
    log('answer', blocker.id, '=', YES, '|', blocker.question.slice(0, 60));
  }

  return updatePatentProject(projectId, { applicant, inventors, answers });
}

function extractApplicantFromQuestion(question: string) {
  const match = question.match(/申请人候选为[「「"']?([^」」"']+)[」」"']?/);
  return match?.[1]?.trim() || '';
}

function extractInventorsFromQuestion(question: string) {
  const match = question.match(/发明人候选为[「「"']?([^」」"'.。]+)[」」"']?/);
  if (!match?.[1]) return [] as string[];
  return match[1].split(/[、，,/]/).map((item) => item.trim()).filter(Boolean);
}

async function main() {
  const resumeId = process.env.PATENT_E2E_RESUME_ID?.trim()
    || (fs.existsSync('storage/tmp-e2e-patent-yes.json')
      ? String(JSON.parse(fs.readFileSync('storage/tmp-e2e-patent-yes.json', 'utf8')).projectId || '')
      : '');

  let project = resumeId ? getPatentProject(resumeId) : null;
  if (project) {
    log('[3] resume project', project.id, project.status);
  } else {
    if (!fs.existsSync(sourcePath)) throw new Error(`PDF not found: ${sourcePath}`);
    const buffer = fs.readFileSync(sourcePath);
    log('[1] pdf bytes', buffer.length);

    const parsed = await parsePatentSource(path.basename(sourcePath), buffer);
    log('[2] parsed chars', parsed.charCount, 'title', parsed.metadata.title);

    project = await createPatentProject({
      name: path.basename(sourcePath),
      mediaType: 'application/pdf',
      buffer,
      parsed
    });
    if (!project) throw new Error('create failed');
    log('[3] project', project.id);
  }
  fs.writeFileSync(
    'storage/tmp-e2e-patent-yes.json',
    JSON.stringify({ projectId: project.id, startedAt: new Date().toISOString() }, null, 2)
  );

  // 若已有待答复问题，先统一答「是」再继续。
  if (project.blockers.some((b) => !b.resolved)) {
    project = answerYesForProject(project.id)!;
  }

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    log(`[4.${round}] run pipeline…`);
    const started = Date.now();
    project = await runPatentPipeline(project.id, (event) => {
      if (event.type === 'status') {
        process.stdout.write(`\r  [${event.progress}%] ${event.stage}: ${String(event.detail || '').slice(0, 100)}`.padEnd(120));
      } else if (event.type === 'artifact') {
        console.log(`\n  artifact=${event.kind} status=${event.project.status}`);
      } else if (event.type === 'error') {
        console.error('\n  ERROR', event.error);
      } else if (event.type === 'done') {
        console.log(`\n  done status=${event.project.status}`);
      }
    });
    console.log('');
    project = getPatentProject(project.id)!;
    log(`[4.${round}] elapsed=${Math.round((Date.now() - started) / 1000)}s status=${project.status} score=${project.qualityScore}`);

    if (project.status === 'needs_input') {
      const open = project.blockers.filter((b) => !b.resolved);
      log(`[5.${round}] needs_input open=${open.length}`);
      if (!open.length) {
        log('needs_input but no open blockers; stop');
        break;
      }
      project = answerYesForProject(project.id)!;
      continue;
    }

    if (['completed', 'ready', 'review_required', 'failed', 'cancelled'].includes(project.status)) {
      break;
    }
  }

  project = getPatentProject(project.id)!;
  const summary = {
    id: project.id,
    status: project.status,
    stage: project.currentStage,
    qualityScore: project.qualityScore,
    title: project.draft?.title || project.disclosure?.proposedTitle || project.title,
    applicant: project.applicant,
    inventors: project.inventors,
    hasDisclosure: Boolean(project.disclosure),
    hasPriorArt: Boolean(project.priorArt),
    hasStrategy: Boolean(project.strategy),
    hasDraft: Boolean(project.draft),
    hasDrawings: Boolean(project.drawings?.assets?.length),
    hasAudit: Boolean(project.audit),
    auditPassed: project.audit?.passed ?? null,
    openBlockers: project.blockers.filter((b) => !b.resolved).map((b) => b.id),
    error: project.error || null
  };
  fs.writeFileSync('storage/tmp-e2e-patent-yes-result.json', JSON.stringify(summary, null, 2));
  log('[result]', JSON.stringify(summary, null, 2));

  if (!summary.hasDisclosure) {
    throw new Error('E2E failed: no disclosure');
  }
  if (summary.status === 'failed') {
    throw new Error(`E2E failed: ${summary.error}`);
  }
  log('[ok] e2e finished');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
