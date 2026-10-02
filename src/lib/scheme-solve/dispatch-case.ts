import fs from 'node:fs';
import path from 'node:path';
import { resolveDispatchRoot } from './dispatch';
import { dispatchDirs } from './dispatch';
import { schemeSolveWorkspaceRoot, writeWorkspaceText } from './workspace';
import type { SchemeIdea } from './types';

const CASE_FILES: Record<string, string> = {
  ieee14: 'examples/inputs/ieee14_acopf.yaml',
  ieee30: 'examples/inputs/ieee30_dcopf.yaml',
  ieee57: 'examples/inputs/ieee57_baseline.yaml',
  ieee118: 'examples/inputs/ieee118_baseline.yaml',
  case33bw: 'examples/inputs/case33bw_pq_24h.yaml',
  main_dist_micro_demo: 'examples/inputs/main_dist_micro_multiscale.yaml',
  free_composition: 'examples/inputs/free_composition_template.yaml'
};

export function resolveDispatchCaseHint(idea: Pick<SchemeIdea, 'caseHint' | 'title' | 'summary' | 'decisions'>) {
  const text = `${idea.caseHint || ''} ${idea.title} ${idea.summary} ${idea.decisions}`.toLowerCase();
  if (/118/.test(text)) return 'ieee118';
  if (/57/.test(text)) return 'ieee57';
  if (/30/.test(text) && !/24/.test(text)) return 'ieee30';
  if (/33|24h|时序|配网/.test(text)) return 'case33bw';
  if (/主配微|微网|pcc/.test(text)) return 'main_dist_micro_demo';
  if (/自由组合|free/.test(text)) return 'free_composition';
  if (idea.caseHint && CASE_FILES[idea.caseHint]) return idea.caseHint;
  return 'ieee14';
}

export function prepareDispatchWorkspace(sessionId: string, idea: SchemeIdea, options?: { overwriteSpec?: boolean }) {
  const caseId = resolveDispatchCaseHint(idea);
  const rel = CASE_FILES[caseId] || CASE_FILES.ieee14;
  const source = path.join(resolveDispatchRoot(), rel);
  const { specPath, outputDir } = dispatchDirs(sessionId, idea.id);
  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.existsSync(source) && (options?.overwriteSpec || !fs.existsSync(specPath))) {
    fs.copyFileSync(source, specPath);
  }
  const forecastProfile = injectForecastProfile(sessionId, outputDir, specPath, idea);
  writeWorkspaceText(
    sessionId,
    idea.id,
    'model.json',
    `${JSON.stringify({
      engine: 'power-dispatch',
      specPath: 'dispatch/run-spec.yaml',
      case: caseId,
      forecastProfile: forecastProfile || undefined
    }, null, 2)}\n`
  );
  return { caseId, specPath, outputDir, forecastProfile };
}

function findSessionForecastProfile(sessionId: string) {
  const root = schemeSolveWorkspaceRoot(sessionId);
  const direct = path.join(root, 'forecast-profile.csv');
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(root)) return null;
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name, 'forecast', 'dispatch-profile.csv');
    if (fs.existsSync(candidate)) return candidate;
    const alt = path.join(root, name, 'forecast', `${name}_profile.csv`);
    if (fs.existsSync(alt)) return alt;
    const folder = path.join(root, name, 'forecast');
    if (!fs.existsSync(folder)) continue;
    const hit = fs.readdirSync(folder).find((file) => file.endsWith('_profile.csv') || file === 'dispatch-profile.csv');
    if (hit) return path.join(folder, hit);
  }
  return null;
}

function injectForecastProfile(sessionId: string, outputDir: string, specPath: string, idea: SchemeIdea) {
  const source = findSessionForecastProfile(sessionId);
  if (!source || !fs.existsSync(specPath)) return null;
  const dest = path.join(outputDir, 'forecast-profile.csv');
  fs.copyFileSync(source, dest);
  let spec = fs.readFileSync(specPath, 'utf8');
  if (/^timeseries:/m.test(spec)) {
    spec = spec.replace(/profile_file:\s*.+$/m, 'profile_file: forecast-profile.csv');
  } else if (/回灌|预测曲线|源荷|光伏出力|风电出力/.test(`${idea.title} ${idea.summary} ${idea.decisions}`)) {
    spec += [
      '',
      'timeseries:',
      '  profile_file: forecast-profile.csv',
      '  steps: 24',
      '  step_minutes: 60',
      ''
    ].join('\n');
  }
  fs.writeFileSync(specPath, spec, 'utf8');
  return dest;
}
