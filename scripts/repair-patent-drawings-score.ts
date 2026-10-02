/**
 * 就地修复项目：重渲附图 + 按新规则重算审校分，不重跑 OpenCode。
 * Usage: npx tsx scripts/repair-patent-drawings-score.ts [projectId]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  readPatentWorkspaceJson,
  readPatentWorkspaceText
} from '../src/lib/opencode/patent';
import {
  buildFallbackDiagramSpecs,
  drawingDescriptionFromAssets,
  persistGeneratedDiagrams
} from '../src/lib/patent-generation/figures';
import {
  getPatentProject,
  getPatentProjectDirectory,
  savePatentArtifact,
  setPatentProgress
} from '../src/lib/patent-generation/store';
import { mergeModelAudit, normalizeClaimsText, validatePatentDraft } from '../src/lib/patent-generation/validators';
import type { PatentDiagramSpec } from '../src/lib/patent-generation/types';

const projectId =
  process.argv[2]
  || (fs.existsSync('storage/tmp-e2e-patent-yes.json')
    ? String(JSON.parse(fs.readFileSync('storage/tmp-e2e-patent-yes.json', 'utf8')).projectId || '')
    : '');

if (!projectId) throw new Error('projectId required');

async function main() {
  const project = getPatentProject(projectId);
  if (!project?.disclosure) throw new Error('project/disclosure missing');
  const projectDir = getPatentProjectDirectory(projectId);

  // 触发 drawings-plan.json 自动修复重写
  const plan = readPatentWorkspaceJson<{ diagrams?: PatentDiagramSpec[] }>(
    projectId,
    'drawings-plan.json'
  );
  let specs = (plan?.diagrams || []).filter((item) => item?.nodes?.length);
  if (!specs.length) {
    specs = buildFallbackDiagramSpecs(project.disclosure, project.strategy).slice(0, 3);
    console.log('using fallback diagram specs', specs.length);
  } else {
    console.log('using repaired plan diagrams', specs.length);
  }

  const assets = await persistGeneratedDiagrams({
    projectDir,
    specs: specs.slice(0, 3),
    startFigureNumber: 1
  });
  console.log('rendered assets', assets.length, assets.map((a) => a.fileName));

  const drawingsBundle = {
    assets,
    generatedFromSuggestions: true,
    notes: ['就地修复：重渲附图并重算质量分']
  };
  savePatentArtifact(projectId, 'drawings', drawingsBundle);

  const claimsText = normalizeClaimsText(
    readPatentWorkspaceText(projectId, 'claims.txt')
    || project.draft?.claims
    || ''
  );
  const draft = {
    ...(project.draft || {
      title: project.disclosure.proposedTitle || project.title,
      abstract: '',
      abstractFigure: '图1',
      technicalField: '',
      backgroundArt: '',
      inventionSummary: '',
      drawingDescription: '',
      claims: '',
      embodiments: '',
      drawings: []
    }),
    claims: claimsText,
    drawingDescription: drawingDescriptionFromAssets(assets),
    abstractFigure: assets.length ? '图1' : '无',
    drawings: assets
  };
  savePatentArtifact(projectId, 'draft', draft, draft.claims);

  const deterministic = validatePatentDraft(draft, project.disclosure, drawingsBundle);
  const modelRaw = readPatentWorkspaceJson<{
    issues?: unknown[];
    supportMatrix?: unknown[];
    remainingRisks?: string[];
  }>(projectId, 'audit.json') || {};
  // 合并 QUALITY_REPORT 中仍标 error、但建议已写“已补入”的项，走同一降级规则
  const quality = readPatentWorkspaceJson<{
    errors?: Array<{ id?: string; severity?: string; message?: string; suggestion?: string; category?: string; location?: string }>;
    warnings?: Array<{ id?: string; severity?: string; message?: string; suggestion?: string; category?: string; location?: string }>;
  }>(projectId, 'QUALITY_REPORT.json');
  const modelIssues = [
    ...((modelRaw.issues || []) as Array<Record<string, unknown>>),
    ...((quality?.errors || []).map((item) => ({ ...item, severity: item.severity || 'error' }))),
    ...((quality?.warnings || []).map((item) => ({ ...item, severity: item.severity || 'warning' })))
  ];
  const seen = new Set<string>();
  const deduped = modelIssues.filter((item) => {
    const id = String(item.id || item.message || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const audit = {
    ...mergeModelAudit(deterministic, {
      issues: deduped as never,
      supportMatrix: (modelRaw.supportMatrix || project.audit?.supportMatrix || []) as never,
      remainingRisks: modelRaw.remainingRisks || project.audit?.remainingRisks || []
    }),
    rounds: project.audit?.rounds || 3
  };
  savePatentArtifact(projectId, 'audit', audit);

  const remainingErrors = [
    ...audit.deterministicIssues.filter((item) => item.severity === 'error'),
    ...audit.modelIssues.filter((item) => item.severity === 'error')
  ];
  const status = remainingErrors.length || !audit.passed ? 'review_required' : 'completed';
  setPatentProgress(projectId, {
    status,
    stage: 'ready',
    qualityScore: audit.score,
    error: remainingErrors.length
      ? `仍有 ${remainingErrors.length} 项 error，请复核。`
      : null
  });

  const figures = fs.existsSync(path.join(projectDir, 'figures'))
    ? fs.readdirSync(path.join(projectDir, 'figures'))
    : [];
  console.log(JSON.stringify({
    id: projectId,
    status,
    score: audit.score,
    passed: audit.passed,
    drawings: assets.length,
    figures,
    errors: remainingErrors.map((item) => item.id),
    warnings: [...audit.deterministicIssues, ...audit.modelIssues]
      .filter((item) => item.severity === 'warning')
      .map((item) => item.id)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
