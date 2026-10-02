import fs from 'node:fs';
import path from 'node:path';

export const V7_EVIDENCE_JSON_FILES = [
  'resources.json',
  'evidence_atoms.jsonl',
  'coverage_matrix.json',
  'metric_cards.json',
  'tri_evidence_map.json',
  'patent_claim_matrix.json',
  'standard_monitor.json',
  'guide_reasoning.json',
  'build_manifest.json'
] as const;

export const V7_DESIGN_MD_FILES = [
  '01_资料准入评分.md',
  '02_六类证据覆盖与NET检索任务.md',
  '03_论文专利标准技术特征映射.md',
  '04_标准依赖与版本监测.md',
  '05_专利权利要求特征矩阵.md',
  '06_工程矛盾研究空白项目增量.md',
  '07_指标卡.md'
] as const;

export const V7_FORMAL_SOURCE_FILES = [
  'guide.json',
  '决策版研究综述.md',
  '单篇资料高密度总结汇编.md',
  '一页总结汇编.md',
  '详细证据附件.md',
  '编制说明与质量检查报告.md',
  '待补证清单.md'
] as const;

export const V7_FORMAL_EDITABLE_FILES = [
  '指南建议稿.docx',
  '决策版研究综述.docx',
  '单篇资料高密度总结汇编.docx',
  '一页总结汇编.docx',
  '详细证据附件.docx',
  '编制说明与质量检查报告.docx',
  '证据系统与指南编制台账.xlsx'
] as const;

export const V7_FORBIDDEN_NAME_RE =
  /(?:^|[\\/])(?:page-\d+\.png|contact_sheets?|xlsx_preview|_空白|_重建|V6_|_V6(?:[._]|$)|00_V6来源说明|09_V6)/i;

const TOPIC_DIR_RE = /^(\d{2})_课题(\d+)_(.+)$/;

export type GridGuideTopicFolder = {
  name: string;
  index: number;
  shortName: string;
  dir: string;
};

export type GridGuideDeliverableAssessment = {
  ready: boolean;
  fileCount: number;
  hasOverall: boolean;
  hasFormal: boolean;
  hasGuideJson: boolean;
  topicCount: number;
  uniqueDenseCount: number;
  uniqueDetailCount: number;
  uniqueOnePageCount: number;
  missing: string[];
  correspondenceIssues: string[];
};

function existsFile(file: string) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function existsDir(dir: string) {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

function listDirNames(dir: string) {
  if (!existsDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name);
}

function countFilesRecursive(dir: string, limit = 800) {
  let count = 0;
  const stack = [dir];
  while (stack.length && count < limit) {
    const current = stack.pop();
    if (!current || !existsDir(current)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) count += 1;
      if (count >= limit) break;
    }
  }
  return count;
}

function countMarkdown(dir: string) {
  if (!existsDir(dir)) return 0;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name)).length;
}

function hasDocLike(dir: string) {
  if (!existsDir(dir)) return false;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .some((entry) => entry.isFile() && /\.(md|markdown|docx)$/i.test(entry.name));
}

function hasAnyFile(dir: string) {
  if (!existsDir(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile());
}

export function listTopicFolders(taskDir: string): GridGuideTopicFolder[] {
  if (!existsDir(taskDir)) return [];
  return fs
    .readdirSync(taskDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = entry.name.match(TOPIC_DIR_RE);
      if (!match) return null;
      return {
        name: entry.name,
        index: Number(match[2]),
        shortName: match[3] || '',
        dir: path.join(taskDir, entry.name)
      };
    })
    .filter((item): item is GridGuideTopicFolder => Boolean(item))
    .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name, 'zh-CN'));
}

function isCanonicalSummaryFile(name: string) {
  return !/dense_summary_|_to_R\d|_and_/i.test(name);
}

function canonicalizeResourceId(fileName: string) {
  return fileName
    .replace(/\.(md|markdown)$/i, '')
    .replace(/_summary$/i, '')
    .replace(/_onepage$/i, '');
}

export function listUniqueSummaryIds(taskDir: string, kind: 'dense' | 'detail' | 'onepage') {
  const relative =
    kind === 'dense'
      ? ['00_项目总体', '07_唯一资料主总结与网络补充', '01_高密度单篇总结_V7']
      : kind === 'detail'
        ? ['00_项目总体', '07_唯一资料主总结与网络补充', '01_详细版']
        : ['00_项目总体', '07_唯一资料主总结与网络补充', '02_一页版'];
  const dir = path.join(taskDir, ...relative);
  if (!existsDir(dir)) return [];
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name) && isCanonicalSummaryFile(entry.name))
    .map((entry) => canonicalizeResourceId(entry.name));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

function sameIdSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function chineseCount(text: string) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

const DUMP_HEADING_RE = /基金项目|文章编号|record_key|Power System Technology|第\s*\d+\s*卷|Vol\.\s*\d+/i;

function looksLikeHeaderDump(text: string) {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
  const head = text.slice(0, 500);
  return DUMP_HEADING_RE.test(heading) || DUMP_HEADING_RE.test(head);
}

function literatureContext(taskDir: string) {
  const extractDir = path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充', '01_全文提取');
  const extractCount = countMarkdown(extractDir);
  const workspaceExtract = path.join(taskDir, '..', 'literature', 'extracted');
  let packCount = extractCount;
  let manuscriptChinese = 0;
  const manifestFile = path.join(workspaceExtract, 'manifest.json');
  if (existsFile(manifestFile)) {
    const data = readJson(manifestFile) as {
      documentCount?: number;
      documents?: unknown[];
      manuscript?: { chinese?: number } | null;
    } | null;
    packCount = Math.max(
      packCount,
      Number(data?.documentCount) || (Array.isArray(data?.documents) ? data!.documents!.length : 0)
    );
    manuscriptChinese = Number(data?.manuscript?.chinese) || 0;
  }
  const manuscriptFile = path.join(taskDir, '00_项目总体', '01_输入与范围', '原稿.md');
  const extractedManuscript = path.join(workspaceExtract, 'manuscript.md');
  if (!manuscriptChinese && existsFile(manuscriptFile)) {
    manuscriptChinese = chineseCount(fs.readFileSync(manuscriptFile, 'utf8'));
  } else if (!manuscriptChinese && existsFile(extractedManuscript)) {
    manuscriptChinese = chineseCount(fs.readFileSync(extractedManuscript, 'utf8'));
  }
  const hasManuscript =
    existsFile(manuscriptFile) ||
    existsFile(extractedManuscript) ||
    manuscriptChinese > 0;
  return {
    extractCount: packCount,
    hasManuscript,
    manuscriptChinese,
    heavy: packCount >= 5 || hasManuscript
  };
}

function summaryQualityIssues(taskDir: string) {
  const issues: string[] = [];
  const literature = literatureContext(taskDir);
  const minDense = literature.heavy ? 1200 : 400;
  const denseDir = path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充', '01_高密度单篇总结_V7');
  if (existsDir(denseDir)) {
    for (const entry of fs.readdirSync(denseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;
      if (!isCanonicalSummaryFile(entry.name)) {
        issues.push(`高密度总结不得合并多篇：${entry.name}`);
        continue;
      }
      const text = fs.readFileSync(path.join(denseDir, entry.name), 'utf8');
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
      const h2 = (text.match(/^##\s+/gm) || []).length;
      if (/[/\\]/.test(heading) || /_summary/i.test(heading)) {
        issues.push(`${entry.name} 题名不得使用文件路径`);
      }
      if (h2 < 5) issues.push(`${entry.name} 高密度总结不足 5 个二级专章`);
      if (looksLikeHeaderDump(text)) {
        issues.push(`${entry.name} 不得用页眉、基金项目或题录切片充当高密度总结`);
      }
      if (chineseCount(text) < minDense) issues.push(`${entry.name} 高密度总结过短，需按专章写完整`);
    }
  }
  const review = path.join(taskDir, '05_正式成果', '决策版研究综述.md');
  if (existsFile(review)) {
    const reviewText = fs.readFileSync(review, 'utf8');
    const minReview = literature.heavy ? 4000 : 200;
    if (chineseCount(reviewText) < minReview) {
      issues.push(literature.heavy ? '决策版研究综述未达到综述级深度' : '决策版研究综述过短');
    }
  }
  if (literature.heavy) {
    if (literature.extractCount >= 5) {
      const copied = countMarkdown(
        path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充', '01_全文提取')
      );
      if (copied < Math.min(literature.extractCount, 8)) {
        issues.push('有文献包时必须保留 01_全文提取，不得只写题录');
      }
    }
    if (literature.hasManuscript) {
      const rewrite = path.join(taskDir, '05_正式成果', '重写稿.md');
      if (!existsFile(rewrite)) {
        issues.push('有原稿时必须写 05_正式成果/重写稿.md');
      } else {
        const minRewrite = Math.max(12000, literature.manuscriptChinese);
        if (chineseCount(fs.readFileSync(rewrite, 'utf8')) < minRewrite) {
          issues.push('重写稿未达到综述级深度，须按证据扩写第一、二章，篇幅不低于原稿');
        }
      }
    }
    for (const topic of listTopicFolders(taskDir)) {
      const reviews = path.join(topic.dir, '04_单课题综述');
      if (!existsDir(reviews)) continue;
      for (const entry of fs.readdirSync(reviews, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;
        const text = fs.readFileSync(path.join(reviews, entry.name), 'utf8');
        if (chineseCount(text) < 1500) {
          issues.push(`${topic.name} 课题综述过短，须按主题综合文献而不是复述页眉`);
        }
      }
    }
  }
  const resourcesPath = path.join(taskDir, '00_项目总体', '04_结构化证据系统', 'resources.json');
  if (existsFile(resourcesPath)) {
    const data = readJson(resourcesPath);
    const rows = resourceRows(data);
    const denseIds = listUniqueSummaryIds(taskDir, 'dense');
    if (rows.length < denseIds.length) {
      issues.push(`resources.json 条目 ${rows.length} 少于唯一资料 ${denseIds.length}`);
    }
  }
  const manifestPath = path.join(taskDir, '00_项目总体', '04_结构化证据系统', 'build_manifest.json');
  if (existsFile(manifestPath)) {
    const manifest = readJson(manifestPath) as { mode?: string } | null;
    if (manifest?.mode === 'host-bootstrap-from-hits') {
      issues.push('禁止用预检索模板交差，必须基于全文撰写');
    }
  }
  return issues;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resourceRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['unique_resources', 'resources', 'items', 'rows']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function guideCorrespondenceIssues(taskDir: string, topics: GridGuideTopicFolder[]) {
  const issues: string[] = [];
  const guidePath = path.join(taskDir, '05_正式成果', 'guide.json');
  if (!existsFile(guidePath)) return issues;
  const data = readJson(guidePath) as {
    topics?: unknown;
    functional_requirements?: unknown;
    key_technologies?: unknown;
    project_name?: unknown;
  } | null;
  if (!data || typeof data !== 'object') {
    issues.push('05_正式成果/guide.json 无法解析');
    return issues;
  }
  const guideTopics = Array.isArray(data.topics) ? data.topics : [];
  const requirements = Array.isArray(data.functional_requirements) ? data.functional_requirements : [];
  const technologies = Array.isArray(data.key_technologies) ? data.key_technologies : [];
  if (guideTopics.length < 3) issues.push('guide.json 课题数少于 3');
  if (guideTopics.length !== topics.length) {
    issues.push(`guide.json 课题数 ${guideTopics.length} 与课题文件夹数 ${topics.length} 不一致`);
  }
  if (requirements.length !== guideTopics.length) {
    issues.push('guide.json 功能需求项数与课题数不一致');
  }
  if (technologies.length !== guideTopics.length) {
    issues.push('guide.json 关键技术项数与课题数不一致');
  }
  if (typeof data.project_name !== 'string' || !data.project_name.trim()) {
    issues.push('guide.json 缺少 project_name');
  }
  return issues;
}

export function assessV7Deliverables(taskDir: string | null): GridGuideDeliverableAssessment {
  if (!taskDir || !existsDir(taskDir)) {
    return {
      ready: false,
      fileCount: 0,
      hasOverall: false,
      hasFormal: false,
      hasGuideJson: false,
      topicCount: 0,
      uniqueDenseCount: 0,
      uniqueDetailCount: 0,
      uniqueOnePageCount: 0,
      missing: ['任务文件夹'],
      correspondenceIssues: []
    };
  }

  const missing: string[] = [];
  const overall = path.join(taskDir, '00_项目总体');
  const formal = path.join(taskDir, '05_正式成果');
  const requiredOverall = [
    ['01_输入与范围', '范围说明.md'],
    ['02_最新范例基线与重复边界', '写作基线.md'],
    ['03_资料总清单与阅读日志', '资料总清单.md'],
    ['06_总成果渲染与检查', '质量检查记录.md'],
    ['07_唯一资料主总结与网络补充', '03_网络补充资料与AI核对表.md'],
    ['07_唯一资料主总结与网络补充', '04_标准版本核验表.md']
  ] as const;
  for (const parts of requiredOverall) {
    const relative = ['00_项目总体', ...parts].join('/');
    if (!existsFile(path.join(taskDir, ...['00_项目总体', ...parts]))) missing.push(relative);
  }
  if (!existsFile(path.join(overall, '03_资料总清单与阅读日志', '阅读日志.md'))) {
    missing.push('00_项目总体/03_资料总清单与阅读日志/阅读日志.md');
  }

  for (const name of V7_EVIDENCE_JSON_FILES) {
    const relative = `00_项目总体/04_结构化证据系统/${name}`;
    if (!existsFile(path.join(overall, '04_结构化证据系统', name))) missing.push(relative);
  }
  for (const name of V7_DESIGN_MD_FILES) {
    const relative = `00_项目总体/05_三类证据与研究设计/${name}`;
    if (!existsFile(path.join(overall, '05_三类证据与研究设计', name))) missing.push(relative);
  }

  const uniqueDense = listUniqueSummaryIds(taskDir, 'dense');
  const uniqueDetail = listUniqueSummaryIds(taskDir, 'detail');
  const uniqueOnePage = listUniqueSummaryIds(taskDir, 'onepage');
  if (!uniqueDense.length) missing.push('00_项目总体/07_唯一资料主总结与网络补充/01_高密度单篇总结_V7/*.md');
  if (!uniqueDetail.length) missing.push('00_项目总体/07_唯一资料主总结与网络补充/01_详细版/*.md');
  if (!uniqueOnePage.length) missing.push('00_项目总体/07_唯一资料主总结与网络补充/02_一页版/*.md');

  const topics = listTopicFolders(taskDir);
  if (topics.length < 3) missing.push('至少 3 个课题文件夹（01_课题1_短名 / 02_课题2_短名 / …）');
  for (const topic of topics) {
    const requiredTopicDirs = [
      ['00_范围依据', 'any'],
      ['03_单篇资料总结_高密度V7', 'md'],
      ['04_单课题综述', 'doc'],
      ['05_课题设计说明', 'doc'],
      ['06_单课题指南', 'doc'],
      ['07_证据映射', 'doc'],
      ['08_渲染与检查', 'any']
    ] as const;
    for (const [folder, kind] of requiredTopicDirs) {
      const dir = path.join(topic.dir, folder);
      const ok =
        kind === 'md' ? countMarkdown(dir) > 0 : kind === 'doc' ? hasDocLike(dir) : hasAnyFile(dir);
      if (!ok) missing.push(`${topic.name}/${folder}/`);
    }
  }

  for (const name of V7_FORMAL_SOURCE_FILES) {
    if (!existsFile(path.join(formal, name))) missing.push(`05_正式成果/${name}`);
  }

  const literature = literatureContext(taskDir);
  const minDenseForPack = Math.min(8, Math.max(3, literature.extractCount));
  const correspondenceIssues = [
    ...guideCorrespondenceIssues(taskDir, topics),
    ...summaryQualityIssues(taskDir),
    ...(uniqueDense.length && uniqueDetail.length && !sameIdSet(uniqueDense, uniqueDetail)
      ? ['高密度总结与详细版资料 ID 不一致']
      : []),
    ...(uniqueDense.length && uniqueOnePage.length && !sameIdSet(uniqueDense, uniqueOnePage)
      ? ['高密度总结与一页版资料 ID 不一致']
      : []),
    ...(uniqueDense.length < Math.max(3, topics.length)
      ? [`唯一高密度总结 ${uniqueDense.length} 份，至少应与课题数一致且不少于 3`]
      : []),
    ...(literature.heavy && uniqueDense.length < minDenseForPack
      ? [`文献包已抽取 ${literature.extractCount} 份全文，高密度总结至少应写 ${minDenseForPack} 份，且不得用题录充数`]
      : [])
  ];

  const hasGuideJson = existsFile(path.join(formal, 'guide.json'));
  const ready =
    missing.length === 0 &&
    correspondenceIssues.length === 0 &&
    topics.length >= 3 &&
    uniqueDense.length >= 3 &&
    hasGuideJson;

  return {
    ready,
    fileCount: countFilesRecursive(taskDir),
    hasOverall: existsDir(overall),
    hasFormal: existsDir(formal),
    hasGuideJson,
    topicCount: topics.length,
    uniqueDenseCount: uniqueDense.length,
    uniqueDetailCount: uniqueDetail.length,
    uniqueOnePageCount: uniqueOnePage.length,
    missing,
    correspondenceIssues
  };
}

export function listMissingDerivedFiles(taskDir: string) {
  const formal = path.join(taskDir, '05_正式成果');
  const required = ['指南建议稿.docx', '证据系统与指南编制台账.xlsx'];
  if (existsFile(path.join(formal, '重写稿.md'))) required.push('重写稿.docx');
  return required.filter((name) => !existsFile(path.join(formal, name)));
}

export function formatMissingDeliverables(assessment: GridGuideDeliverableAssessment) {
  const items = [...assessment.missing, ...assessment.correspondenceIssues];
  if (!items.length) return '';
  return items
    .slice(0, 40)
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');
}

export function listForbiddenGeneratedFiles(taskDir: string) {
  const hits: string[] = [];
  const stack = [taskDir];
  while (stack.length && hits.length < 40) {
    const current = stack.pop();
    if (!current || !existsDir(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(taskDir, full).replace(/\\/g, '/');
      if (V7_FORBIDDEN_NAME_RE.test(relative)) hits.push(relative);
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return hits;
}
