import { resolveForecastHorizon, resolveForecastKind, resolveForecastModel, resolveForecastVariant } from './forecast';
import { inferModelicaSpec } from './modelica';
import type { SchemeIdea } from './types';

export type ModelKind = 'dcopf-case' | 'linear' | 'mps' | 'mgplan' | 'acopf' | 'dispatch' | 'loss' | 'modelica' | 'forecast' | 'invalid';

export type ParsedModel = {
  kind: ModelKind;
  spec: Record<string, unknown> | null;
  caseName?: string;
  reason?: string;
};

const CASE_NAME = /^(?:pglib_opf_)?case\d+$/i;
const COMPLEX_GRID = /N-1|机组组合|扩建|分段|拓扑|开断|投运|预想事故/i;

export function inferEsoptCase(text: string): 'case24' | 'case500' | null {
  const value = String(text || '').toLowerCase();
  if (/case500|500_goc|goc.?500|500\s*节点/.test(value)) return 'case500';
  if (/case24|rts-?24|ieee\s*24|pglib.*24|24\s*节点|24-bus/.test(value)) return 'case24';
  return null;
}

export function normalizeEsoptCase(value?: string | null): string | null {
  const inferred = inferEsoptCase(String(value || ''));
  if (inferred) return inferred;
  const name = String(value || '').trim();
  if (!name || name === 'custom') return null;
  if (name === '24') return 'case24';
  if (name === '500') return 'case500';
  if (CASE_NAME.test(name)) return name.replace(/^pglib_opf_/i, '').toLowerCase();
  return null;
}

export function looksLikeCaseName(value?: string | null) {
  return Boolean(normalizeEsoptCase(value) || inferEsoptCase(String(value || '')));
}

export function extractJsonObject(raw: string): unknown | null {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence?.[1] || text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hasNamedVariables(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.some((item) => {
    const row = asRecord(item);
    return Boolean(row && typeof row.name === 'string' && row.name.trim());
  });
}

function normalizeVariables(spec: Record<string, unknown>) {
  if (hasNamedVariables(spec.variables)) return spec;
  const mapped = asRecord(spec.variables);
  if (!mapped) return spec;
  const variables = Object.entries(mapped).map(([name, value]) => {
    const row = asRecord(value) || {};
    return { name, ...row };
  });
  if (!hasNamedVariables(variables)) return spec;
  return { ...spec, variables };
}

function unwrapModel(value: unknown): Record<string, unknown> | null {
  let current = asRecord(value);
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const next = asRecord(current.model) || asRecord(current.data) || asRecord(current.spec) || asRecord(current.payload);
    if (!next) break;
    current = next;
  }
  return current ? normalizeVariables(current) : null;
}

function hasObjective(spec: Record<string, unknown>) {
  const objective = spec.objective;
  if (typeof objective === 'string' && objective.trim()) return true;
  const row = asRecord(objective);
  if (!row) return false;
  return Boolean(row.expr || row.terms || row.sense);
}

function hasUsableConstraints(spec: Record<string, unknown>) {
  if (spec.constraints == null) return true;
  if (!Array.isArray(spec.constraints)) return false;
  return spec.constraints.every((item) => {
    const row = asRecord(item);
    return Boolean(row && (row.expr || row.lhs || row.terms));
  });
}

export function classifyModelSpec(value: unknown): ParsedModel {
  const spec = unwrapModel(value);
  if (!spec) return { kind: 'invalid', spec: null, reason: 'model.json 不是对象' };
  if (spec.engine === 'openTEPES' || spec.configDir === 'mgplan/config') {
    return { kind: 'mgplan', spec };
  }
  if (spec.engine === 'tdmg-acopf' || spec.configDir === 'tdmg/input') {
    return { kind: 'acopf', spec, caseName: typeof spec.case === 'string' ? spec.case.trim() : undefined };
  }
  if (spec.engine === 'power-dispatch' || spec.specPath === 'dispatch/run-spec.yaml') {
    return { kind: 'dispatch', spec, caseName: typeof spec.case === 'string' ? spec.case.trim() : undefined };
  }
  if (spec.engine === 'nwxs-loss') {
    return { kind: 'loss', spec };
  }
  if (spec.engine === 'openmodelica') {
    return { kind: 'modelica', spec };
  }
  if (spec.engine === 'pv-wind-load-forecast') {
    return { kind: 'forecast', spec };
  }
  const modelFile = typeof spec.modelFile === 'string'
    ? spec.modelFile
    : typeof spec.modelPath === 'string'
      ? spec.modelPath
      : '';
  const mode = String(spec.mode || '').toLowerCase();
  if (
    mode === 'mps'
    || mode === 'lp'
    || /\.(mps|lp)$/i.test(modelFile)
    || (spec.engine === 'esopt' && /\.(mps|lp)$/i.test(modelFile))
  ) {
    return { kind: 'mps', spec };
  }

  if (hasNamedVariables(spec.variables) && hasObjective(spec)) {
    if (!hasUsableConstraints(spec)) {
      return { kind: 'invalid', spec, reason: 'model.json 的 constraints 无法交给求解器' };
    }
    return { kind: 'linear', spec };
  }

  const caseName = typeof spec.case === 'string' ? spec.case.trim() : '';
  if (caseName && looksLikeCaseName(caseName)) {
    return { kind: 'dcopf-case', spec, caseName };
  }
  if (caseName) {
    return { kind: 'dcopf-case', spec, caseName };
  }

  if (hasNamedVariables(spec.variables) && !hasObjective(spec)) {
    return { kind: 'invalid', spec, reason: 'model.json 缺少 objective' };
  }
  if (spec.variables != null && !hasNamedVariables(spec.variables)) {
    return { kind: 'invalid', spec, reason: 'model.json 的 variables 不是有效数组' };
  }
  return { kind: 'invalid', spec, reason: 'model.json 既不是标准算例，也缺少 variables/objective' };
}

export function parseModelFile(raw?: string | null): ParsedModel {
  if (!raw?.trim()) return { kind: 'invalid', spec: null, reason: 'model.json 为空' };
  const extracted = extractJsonObject(raw);
  if (extracted == null) return { kind: 'invalid', spec: null, reason: 'model.json 不是合法 JSON' };
  return classifyModelSpec(extracted);
}

export function isSimpleDcopfCase(idea: Pick<SchemeIdea, 'problemClass' | 'caseHint' | 'title' | 'summary' | 'decisions' | 'limits'>) {
  if (idea.problemClass === 'acopf' || idea.problemClass === 'mgplan' || idea.problemClass === 'dispatch' || idea.problemClass === 'loss' || idea.problemClass === 'modelica' || idea.problemClass === 'forecast') return false;
  const text = `${idea.caseHint || ''} ${idea.title} ${idea.summary} ${idea.decisions} ${idea.limits}`;
  const caseName = normalizeEsoptCase(idea.caseHint) || inferEsoptCase(text);
  if (!caseName) return false;
  if (/交流|AC-?OPF|有功无功|pandapower/i.test(text) && !/直流|DCOPF/i.test(text)) return false;
  if (COMPLEX_GRID.test(text) && idea.problemClass !== 'dcopf') return false;
  return idea.problemClass === 'dcopf'
    || idea.problemClass === 'lp'
    || /直流|DCOPF|最优潮流|IEEE|节点系统|PGLib|RTS/i.test(text);
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

function uniqueNames(text: string) {
  const reserved = new Set(['min', 'max', 'minimize', 'maximize', 's', 't', 'st']);
  const names: string[] = [];
  for (const match of text.matchAll(IDENT)) {
    const name = match[0];
    if (reserved.has(name.toLowerCase()) || names.includes(name)) continue;
    names.push(name);
  }
  return names.filter((name) => !names.some((other) => {
    if (other === name || !other.startsWith(name)) return false;
    return /^[A-Za-z]/.test(other.slice(name.length));
  }));
}

function isMathConstraint(expr: string) {
  return /^(?:[A-Za-z_][A-Za-z0-9_]*|\d)[A-Za-z0-9_+\-*/.\s()]*\s*(<=|>=|=)\s*[A-Za-z0-9_+\-*/.\s()]+$/.test(expr);
}

export function inferExplicitLinearModel(text: string, problemClass?: string) {
  const blob = String(text || '').replace(/\s+/g, ' ').trim();
  const objectiveMatch = blob.match(/(?:目标|objective)\s*[:：]?\s*(min|max|minimize|maximize)\s+([A-Za-z0-9_+\-*/.\s()]+)/i);
  if (!objectiveMatch) return null;
  const sense = /max/i.test(objectiveMatch[1] || '') ? 'max' : 'min';
  const objectiveExpr = `${sense} ${objectiveMatch[2]!.trim()}`;
  const afterConstraint = blob.split(/(?:约束|constraints?)\s*[:：]/i)[1] || '';
  const block = afterConstraint.split(/(?:目标|objective)\s*[:：]?/i)[0] || '';
  const constraintChunks: string[] = [];
  for (const piece of block.split(/[，,；;。]/)) {
    const expr = piece.replace(/^(?:约束\d*|constraint\s*\d*)\s*[:：]?\s*/i, '').trim();
    if (isMathConstraint(expr)) constraintChunks.push(expr);
  }
  if (!constraintChunks.length) return null;
  const mathNames = uniqueNames(`${constraintChunks.join(' ')} ${objectiveMatch[2]}`);
  const namedBlocks = [...blob.matchAll(/(?:决策变量|变量)\s*[:：]?\s*([A-Za-z_][A-Za-z0-9_、,，\s]+)/g)]
    .map((item) => item[1] || '')
    .sort((left, right) => right.length - left.length);
  const namedNames = namedBlocks[0] ? uniqueNames(namedBlocks[0]) : [];
  const names = mathNames.length ? mathNames : namedNames;
  if (names.length < 1) return null;
  const binary = problemClass === 'mip' || /0-1|0\/1|binary|二进制/.test(blob);
  return {
    variables: names.map((name) => ({
      name,
      lb: 0,
      domain: binary ? 'binary' : 'continuous'
    })),
    constraints: constraintChunks.map((expr, index) => ({ name: `c${index + 1}`, expr })),
    objective: { expr: objectiveExpr }
  };
}

export function templateModelJson(idea: SchemeIdea): Record<string, unknown> | null {
  if (idea.problemClass === 'mgplan') {
    return { engine: 'openTEPES', case: 'sSEP', configDir: 'mgplan/config' };
  }
  if (idea.problemClass === 'acopf') {
    return { engine: 'tdmg-acopf', case: idea.caseHint || 'case9', configDir: 'tdmg/input' };
  }
  if (idea.problemClass === 'dispatch') {
    return { engine: 'power-dispatch', specPath: 'dispatch/run-spec.yaml', case: idea.caseHint || 'ieee14' };
  }
  if (idea.problemClass === 'loss') {
    return { engine: 'nwxs-loss', input: 'loss/input.json', format: 'full', method: '04' };
  }
  if (idea.problemClass === 'modelica') {
    const spec = inferModelicaSpec(`${idea.caseHint || ''} ${idea.title} ${idea.summary}`);
    return {
      engine: 'openmodelica',
      modelFile: 'modelica/model.mo',
      model_name: spec.name,
      outputs: spec.outputs
    };
  }
  if (idea.problemClass === 'forecast') {
    const text = `${idea.caseHint || ''} ${idea.title} ${idea.summary} ${idea.decisions || ''}`;
    return {
      engine: 'pv-wind-load-forecast',
      kind: resolveForecastKind(text),
      model: resolveForecastModel(text),
      action: /训练|train/i.test(text) ? 'train' : 'predict',
      horizon: resolveForecastHorizon(text),
      variant: resolveForecastVariant(text)
    };
  }
  const source = [idea.summary, idea.decisions, idea.limits, idea.goal].filter(Boolean).join(' ');
  const text = `${idea.title} ${source}`;
  const inferredCase = normalizeEsoptCase(idea.caseHint) || inferEsoptCase(`${idea.caseHint || ''} ${text}`);
  if (idea.problemClass === 'dcopf' && inferredCase) {
    return { case: inferredCase };
  }
  if (isSimpleDcopfCase(idea) && inferredCase) {
    return { case: inferredCase };
  }
  const explicit = (idea.problemClass === 'lp' || idea.problemClass === 'mip')
    ? inferExplicitLinearModel(source, idea.problemClass) || inferExplicitLinearModel(text, idea.problemClass)
    : null;
  if (explicit) return explicit;
  if (/配料|配餐|营养|diet/i.test(text)) {
    return {
      variables: [
        { name: 'bread', lb: 0, ub: 10, domain: 'continuous' },
        { name: 'milk', lb: 0, ub: 10, domain: 'continuous' }
      ],
      constraints: [
        { name: 'protein', expr: '4*bread + 8*milk >= 20' },
        { name: 'budget', expr: '2*bread + 3*milk <= 12' }
      ],
      objective: { expr: 'min 2*bread + 3*milk' }
    };
  }
  if (/背包|knapsack|投资组合/i.test(text)) {
    return {
      variables: [
        { name: 'a', domain: 'binary' },
        { name: 'b', domain: 'binary' },
        { name: 'c', domain: 'binary' }
      ],
      constraints: [{ name: 'weight', expr: '2*a + 3*b + 4*c <= 5' }],
      objective: { expr: 'max 3*a + 4*b + 5*c' }
    };
  }
  if (inferredCase) {
    return { case: inferredCase };
  }
  return null;
}

export function fallbackModelJson(idea: SchemeIdea): Record<string, unknown> | null {
  return templateModelJson(idea);
}

export function stringifyModel(spec: Record<string, unknown>) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
