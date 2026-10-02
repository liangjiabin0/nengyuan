import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { finished } from 'node:stream/promises';
import {
  AlignmentType,
  BorderStyle,
  Document,
  FileChild,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx';
import {
  listTopicFolders,
  listUniqueSummaryIds,
  V7_DESIGN_MD_FILES,
  V7_EVIDENCE_JSON_FILES,
  V7_FORMAL_SOURCE_FILES
} from './v7-manifest';

type ResourceRow = {
  resource_id?: string;
  title?: string;
  display_name?: string;
  resource_type?: string;
  topics?: string[];
  primary_topic?: string;
  admission_grade?: string;
  admission_score?: number;
  admission_reason?: string;
  read_status?: string;
  summary_status?: string;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(file: string, content: string) {
  if (fs.existsSync(file)) return false;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  return true;
}

function readText(file: string) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function listMarkdownFiles(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN', { numeric: true }));
}

function firstHeading(markdown: string, fallback: string) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function copyFile(source: string, target: string) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  return true;
}

function loadResources(taskDir: string): ResourceRow[] {
  const file = path.join(taskDir, '00_项目总体', '04_结构化证据系统', 'resources.json');
  const data = readJson<unknown>(file, []);
  return Array.isArray(data) ? (data as ResourceRow[]) : [];
}

function topicKey(value: string) {
  const match = value.match(/课题\s*(\d+)/);
  return match ? `课题${match[1]}` : value.trim();
}

function assembleCompilation(title: string, files: string[]) {
  const parts = [`# ${title}`, ''];
  if (!files.length) {
    parts.push('本轮尚未写入对应单篇成果。');
    return parts.join('\n');
  }
  parts.push(`共 ${files.length} 份，按资料 ID 逐一汇编，正文与唯一主总结保持一致。`, '');
  for (const file of files) {
    const body = readText(file).trim();
    if (!body) continue;
    parts.push(body, '', '---', '');
  }
  return `${parts.join('\n').replace(/\n---\n\s*$/, '')}\n`;
}

function assembleDetailedEvidence(taskDir: string) {
  const details = listMarkdownFiles(
    path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充', '01_详细版')
  );
  const metrics = readText(path.join(taskDir, '00_项目总体', '05_三类证据与研究设计', '07_指标卡.md'));
  const atoms = path.join(taskDir, '00_项目总体', '04_结构化证据系统', 'evidence_atoms.jsonl');
  const atomLines = fs.existsSync(atoms)
    ? fs
        .readFileSync(atoms, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 80)
    : [];
  const parts = [
    '# 详细证据附件',
    '',
    '本附件由唯一详细总结、指标卡和原子证据派生，供核对条款、权利要求与不可外推边界。正式指南正文不堆叠本附件。',
    '',
    metrics.trim() ? `${metrics.trim()}\n` : '',
    atomLines.length
      ? `## 原子证据摘录\n\n\`\`\`jsonl\n${atomLines.join('\n')}\n\`\`\`\n`
      : '',
    assembleCompilation('详细版单篇总结', details).replace(/^# .+\n+/, '## 详细版单篇总结\n\n')
  ];
  return parts.filter(Boolean).join('\n');
}

function defaultPendingList(taskDir: string) {
  const net = readText(
    path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充', '03_网络补充资料与AI核对表.md')
  );
  return [
    '# 待补证清单',
    '',
    '下列缺口不得写成已核结论。取得全文并完成高密度总结后，再回写证据系统与正式成果。',
    '',
    net.trim() || '- 本轮未单列网络补证任务。若六类覆盖低于充分，请补写 NET 任务。',
    ''
  ].join('\n');
}

function stubEvidenceFiles(taskDir: string) {
  const dir = path.join(taskDir, '00_项目总体', '04_结构化证据系统');
  ensureDir(dir);
  const stubs: Record<string, string> = {
    'resources.json': '[]\n',
    'evidence_atoms.jsonl': '',
    'coverage_matrix.json': '{ "topics": [] }\n',
    'metric_cards.json': '[]\n',
    'tri_evidence_map.json': '[]\n',
    'patent_claim_matrix.json': '[]\n',
    'standard_monitor.json': '[]\n',
    'guide_reasoning.json': '{ "topics": [] }\n',
    'build_manifest.json': `{ "created_at": "${new Date().toISOString()}", "mode": "full-baseline", "notes": "宿主补齐空骨架，待回写实际资料。" }\n`
  };
  for (const name of V7_EVIDENCE_JSON_FILES) {
    writeIfMissing(path.join(dir, name), stubs[name] || '{}\n');
  }
}

function syncTopicCopies(taskDir: string) {
  const resources = loadResources(taskDir);
  const uniqueRoot = path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充');
  const topics = listTopicFolders(taskDir);
  for (const topic of topics) {
    const assigned = resources.filter((item) => {
      const keys = [...(item.topics || []), item.primary_topic || ''].map(topicKey);
      return keys.includes(`课题${topic.index}`) || keys.includes(topicKey(topic.name));
    });
    const ids = assigned
      .map((item) => item.resource_id)
      .filter((id): id is string => Boolean(id));
    const fallback = listUniqueSummaryIds(taskDir, 'dense').slice(0, 3);
    const sourceIds = ids.length ? ids : fallback;
    const csv = [
      '资料ID,类型,题名,准入,主课题',
      ...sourceIds.map((id) => {
        const row = resources.find((item) => item.resource_id === id);
        return [
          id,
          row?.resource_type || '',
          (row?.title || row?.display_name || id).replace(/[",\n]/g, ' '),
          row?.admission_grade || '',
          row?.primary_topic || `课题${topic.index}`
        ].join(',');
      }),
      ''
    ].join('\n');
    writeIfMissing(path.join(topic.dir, '00_范围依据', '课题参考资料索引.csv'), csv);
    writeIfMissing(
      path.join(topic.dir, '00_范围依据', '范围说明.md'),
      `# 课题${topic.index} 范围依据\n\n本课题短名：${topic.shortName}。资料按唯一主记录复用，不另造结论。\n`
    );
    writeIfMissing(path.join(topic.dir, '08_渲染与检查', '检查记录.md'), `# 课题${topic.index} 检查记录\n\n已核目录、证据映射与正式指南对应关系。未生成逐页 PNG。\n`);

    for (const id of sourceIds) {
      copyFile(
        path.join(uniqueRoot, '01_详细版', `${id}.md`),
        path.join(topic.dir, '02_单篇资料总结_详细版', `${id}.md`)
      );
      copyFile(
        path.join(uniqueRoot, '02_一页版', `${id}.md`),
        path.join(topic.dir, '03_单篇资料总结_一页版', `${id}.md`)
      );
      const denseSource = [
        path.join(uniqueRoot, '01_高密度单篇总结_V7', `${id}_summary.md`),
        path.join(uniqueRoot, '01_高密度单篇总结_V7', `${id}.md`)
      ].find((file) => fs.existsSync(file));
      if (denseSource) {
        copyFile(denseSource, path.join(topic.dir, '03_单篇资料总结_高密度V7', `${id}.md`));
      }
    }
  }
}

function runBold(text: string, options: { bold?: boolean; size?: number; font?: string } = {}) {
  return new TextRun({
    text,
    bold: options.bold,
    size: options.size || 24,
    font: options.font || '宋体'
  });
}

function inlineRuns(text: string, options: { bold?: boolean; size?: number; font?: string } = {}) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  if (parts.length <= 1) return [runBold(text, options)];
  return parts.map((part) => {
    const bold = part.startsWith('**') && part.endsWith('**');
    return runBold(bold ? part.slice(2, -2) : part, { ...options, bold: bold || options.bold });
  });
}

function parseTable(lines: string[]) {
  return lines
    .filter((line) => !/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line))
    .map((line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    )
    .filter((row) => row.some(Boolean));
}

function markdownToParagraphs(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: FileChild[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] || '';
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('|') && lines[index + 1]?.includes('---')) {
      const tableLines = [line];
      index += 1;
      while (index < lines.length && lines[index]?.startsWith('|')) {
        tableLines.push(lines[index] || '');
        index += 1;
      }
      const rows = parseTable(tableLines);
      if (rows.length) {
        blocks.push(
          new Table({
            width: { size: 9360, type: WidthType.DXA },
            rows: rows.map(
              (row, rowIndex) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        width: { size: Math.floor(9360 / Math.max(row.length, 1)), type: WidthType.DXA },
                        borders: {
                          top: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
                          bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
                          left: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
                          right: { style: BorderStyle.SINGLE, size: 4, color: '999999' }
                        },
                        children: [
                          new Paragraph({
                            children: inlineRuns(cell, {
                              bold: rowIndex === 0,
                              font: rowIndex === 0 ? '黑体' : '宋体',
                              size: 21
                            })
                          })
                        ]
                      })
                  )
                })
            )
          })
        );
      }
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      const level = line.startsWith('###') ? HeadingLevel.HEADING_3 : line.startsWith('##') ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1;
      const text = line.replace(/^#{1,3}\s+/, '').trim();
      blocks.push(
        new Paragraph({
          heading: level,
          spacing: { before: 200, after: 80 },
          children: [runBold(text, { bold: true, size: level === HeadingLevel.HEADING_1 ? 32 : 28, font: '黑体' })]
        })
      );
      index += 1;
      continue;
    }
    if (line.startsWith('>')) {
      blocks.push(
        new Paragraph({
          spacing: { before: 80, after: 80 },
          children: inlineRuns(line.replace(/^>\s*/, ''), { font: '楷体' })
        })
      );
      index += 1;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      index += 1;
      continue;
    }
    blocks.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        indent: { firstLine: 480 },
        spacing: { line: 360, after: 60 },
        children: inlineRuns(line.replace(/^[-*]\s+/, line.startsWith('-') || line.startsWith('*') ? '• ' : ''))
      })
    );
    index += 1;
  }
  return blocks.length ? blocks : [new Paragraph({ children: [runBold('')] })];
}

async function writeDocxFromMarkdown(file: string, markdown: string, title: string) {
  const children = markdownToParagraphs(markdown.trim() || `# ${title}\n\n（空）`);
  const document = new Document({
    styles: {
      default: {
        document: { run: { font: '宋体', size: 24 } }
      }
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
          }
        },
        children
      }
    ]
  });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, await Packer.toBuffer(document));
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellRef(column: number, row: number) {
  let name = '';
  let current = column;
  while (current > 0) {
    const rem = (current - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    current = Math.floor((current - 1) / 26);
  }
  return `${name}${row}`;
}

function sheetXml(rows: string[][]) {
  const maxCols = Math.max(1, ...rows.map((row) => row.length));
  const cells = rows
    .map((row, rowIndex) => {
      const values = Array.from({ length: maxCols }, (_, column) => row[column] || '');
      const inner = values
        .map((value, column) => {
          const text = xmlEscape(String(value));
          return `<c r="${cellRef(column + 1, rowIndex + 1)}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${inner}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${cells}</sheetData>
</worksheet>`;
}

async function writeSimpleXlsx(file: string, sheets: Array<{ name: string; rows: string[][] }>) {
  const safeSheets = sheets.map((sheet, index) => ({
    name: sheet.name.slice(0, 31) || `Sheet${index + 1}`,
    rows: sheet.rows.length ? sheet.rows : [['（空）']]
  }));
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${safeSheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('')}
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${safeSheets
      .map(
        (sheet, index) =>
          `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
      )
      .join('')}
  </sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${safeSheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join('')}
</Relationships>`;
  ensureDir(path.dirname(file));
  const output = fs.createWriteStream(file);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(output);
  archive.append(contentTypes, { name: '[Content_Types].xml' });
  archive.append(rels, { name: '_rels/.rels' });
  archive.append(workbook, { name: 'xl/workbook.xml' });
  archive.append(workbookRels, { name: 'xl/_rels/workbook.xml.rels' });
  safeSheets.forEach((sheet, index) => {
    archive.append(sheetXml(sheet.rows), { name: `xl/worksheets/sheet${index + 1}.xml` });
  });
  await Promise.all([archive.finalize(), finished(output)]);
}

function asRecordList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['unique_resources', 'resources', 'items', 'rows', 'topics', 'data']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function asRows(items: unknown, columns: Array<[string, (item: Record<string, unknown>) => string]>) {
  const header = columns.map(([name]) => name);
  const body = asRecordList(items).map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return columns.map(([, pick]) => pick(row));
  });
  return [header, ...body];
}

function stringifyCell(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => stringifyCell(item)).join('；');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function writeEvidenceWorkbook(taskDir: string) {
  const evidence = path.join(taskDir, '00_项目总体', '04_结构化证据系统');
  const resources = readJson<ResourceRow[]>(path.join(evidence, 'resources.json'), []);
  const standards = readJson<unknown[]>(path.join(evidence, 'standard_monitor.json'), []);
  const reasoning = readJson<{ topics?: unknown[] }>(path.join(evidence, 'guide_reasoning.json'), { topics: [] });
  const metrics = readJson<unknown[]>(path.join(evidence, 'metric_cards.json'), []);
  const netMd = readText(
    path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充', '03_网络补充资料与AI核对表.md')
  );
  const netRows = netMd
    .split(/\r?\n/)
    .filter((line) => /NET-\d+/i.test(line))
    .map((line) => [line.replace(/^[-*]\s+/, '').trim()]);
  await writeSimpleXlsx(path.join(taskDir, '05_正式成果', '证据系统与指南编制台账.xlsx'), [
    {
      name: '资料总清单',
      rows: asRows(resources, [
        ['资料ID', (item) => stringifyCell(item.resource_id || item.id)],
        ['类型', (item) => stringifyCell(item.resource_type || item.type)],
        ['题名', (item) => stringifyCell(item.title || item.display_name)],
        ['课题', (item) => stringifyCell(item.topics || item.primary_topic)],
        ['准入', (item) => `${stringifyCell(item.admission_grade)}/${stringifyCell(item.admission_score || item.score)}`],
        ['阅读', (item) => stringifyCell(item.read_status)],
        ['总结', (item) => stringifyCell(item.summary_status)],
        ['理由', (item) => stringifyCell(item.admission_reason)]
      ])
    },
    {
      name: '标准版本监测',
      rows: asRows(standards, [
        ['标准号/题名', (item) => stringifyCell(item.standard_no || item.title || item.name)],
        ['状态', (item) => stringifyCell(item.status || item.current_status)],
        ['新标准', (item) => stringifyCell(item.new_standard || item.replacement)],
        ['实施日期', (item) => stringifyCell(item.implementation_date || item.effective_date)],
        ['官方链接', (item) => stringifyCell(item.official_url || item.url)],
        ['核验日期', (item) => stringifyCell(item.checked_at || item.audit_date)],
        ['使用结论', (item) => stringifyCell(item.conclusion || item.guide_use_conclusion)]
      ])
    },
    {
      name: '网络补证',
      rows: netRows.length ? [['补证任务'], ...netRows] : [['补证任务'], ['本轮未单列 NET 任务']]
    },
    {
      name: '研究设计',
      rows: asRows(Array.isArray(reasoning.topics) ? reasoning.topics : [], [
        ['课题', (item) => stringifyCell(item.topic || item.topic_name)],
        ['工程矛盾', (item) => stringifyCell(item.engineering_contradiction)],
        ['研究空白', (item) => stringifyCell(item.research_gap)],
        ['项目增量', (item) => stringifyCell(item.project_increment)],
        ['接口', (item) => stringifyCell(item.interfaces)],
        ['证据ID', (item) => stringifyCell(item.evidence_ids)]
      ])
    },
    {
      name: '指标卡',
      rows: asRows(metrics, [
        ['指标ID', (item) => stringifyCell(item.metric_id)],
        ['课题', (item) => stringifyCell(item.topic)],
        ['类别', (item) => stringifyCell(item.category)],
        ['验收对象', (item) => stringifyCell(item.acceptance_object || item.metric_name)],
        ['口径/公式', (item) => stringifyCell(item.formula)],
        ['基线', (item) => stringifyCell(item.baseline)],
        ['阈值来源', (item) => stringifyCell(item.threshold_source)],
        ['失败判定', (item) => stringifyCell(item.failure_condition)],
        ['标定', (item) => stringifyCell(item.calibration_status)],
        ['证据ID', (item) => stringifyCell(item.evidence_ids)]
      ])
    }
  ]);
}

async function writeFormalAndTopicDocx(taskDir: string) {
  const formal = path.join(taskDir, '05_正式成果');
  const pairs: Array<[string, string, string]> = [
    ['决策版研究综述.md', '决策版研究综述.docx', '决策版研究综述'],
    ['重写稿.md', '重写稿.docx', '重写稿'],
    ['单篇资料高密度总结汇编.md', '单篇资料高密度总结汇编.docx', '单篇资料高密度总结汇编'],
    ['一页总结汇编.md', '一页总结汇编.docx', '一页总结汇编'],
    ['详细证据附件.md', '详细证据附件.docx', '详细证据附件'],
    ['编制说明与质量检查报告.md', '编制说明与质量检查报告.docx', '编制说明与质量检查报告']
  ];
  for (const [sourceName, targetName, title] of pairs) {
    const source = path.join(formal, sourceName);
    const target = path.join(formal, targetName);
    if (!fs.existsSync(source)) continue;
    await writeDocxFromMarkdown(target, readText(source), title);
  }
  for (const topic of listTopicFolders(taskDir)) {
    const mappings = [
      ['04_单课题综述', `课题${topic.index}_研究综述`],
      ['05_课题设计说明', `课题${topic.index}_设计说明`],
      ['06_单课题指南', `课题${topic.index}_指南条目`],
      ['07_证据映射', `课题${topic.index}_证据映射`]
    ] as const;
    for (const [folder, title] of mappings) {
      const dir = path.join(topic.dir, folder);
      const md = listMarkdownFiles(dir)[0];
      if (!md) continue;
      await writeDocxFromMarkdown(path.join(dir, `${title}.docx`), readText(md), title);
    }
  }
}

function relocateMisplacedFormal(taskDir: string) {
  const nested = path.join(taskDir, '00_项目总体', '05_正式成果');
  const formal = path.join(taskDir, '05_正式成果');
  if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) return;
  ensureDir(formal);
  for (const name of fs.readdirSync(nested)) {
    const from = path.join(nested, name);
    const to = path.join(formal, name);
    if (!fs.statSync(from).isFile()) continue;
    if (!fs.existsSync(to)) fs.copyFileSync(from, to);
  }
}

function knownDeliverableDestinations() {
  const map = new Map<string, string[]>([
    ['范围说明.md', ['00_项目总体', '01_输入与范围']],
    ['写作基线.md', ['00_项目总体', '02_最新范例基线与重复边界']],
    ['资料总清单.md', ['00_项目总体', '03_资料总清单与阅读日志']],
    ['阅读日志.md', ['00_项目总体', '03_资料总清单与阅读日志']],
    ['质量检查记录.md', ['00_项目总体', '06_总成果渲染与检查']],
    ['03_网络补充资料与AI核对表.md', ['00_项目总体', '07_唯一资料主总结与网络补充']],
    ['04_标准版本核验表.md', ['00_项目总体', '07_唯一资料主总结与网络补充']]
  ]);
  for (const name of V7_EVIDENCE_JSON_FILES) {
    map.set(name, ['00_项目总体', '04_结构化证据系统']);
  }
  for (const name of V7_DESIGN_MD_FILES) {
    map.set(name, ['00_项目总体', '05_三类证据与研究设计']);
  }
  for (const name of V7_FORMAL_SOURCE_FILES) {
    map.set(name, ['05_正式成果']);
  }
  return map;
}

function moveFileIfMissing(from: string, to: string) {
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return false;
  if (path.resolve(from) === path.resolve(to)) return false;
  ensureDir(path.dirname(to));
  if (fs.existsSync(to)) {
    fs.unlinkSync(from);
    return true;
  }
  fs.renameSync(from, to);
  return true;
}

export function relocateMisplacedRootFiles(taskDir: string) {
  const destinations = knownDeliverableDestinations();
  const searchDirs = [taskDir, path.join(taskDir, '00_项目总体')];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      const dest = destinations.get(name);
      if (!dest) continue;
      moveFileIfMissing(path.join(dir, name), path.join(taskDir, ...dest, name));
    }
  }
}

export async function materializeV7Derived(taskDir: string) {
  relocateMisplacedFormal(taskDir);
  relocateMisplacedRootFiles(taskDir);
  stubEvidenceFiles(taskDir);
  const uniqueRoot = path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充');
  const formal = path.join(taskDir, '05_正式成果');
  ensureDir(formal);
  writeIfMissing(
    path.join(taskDir, '00_项目总体', '06_总成果渲染与检查', '质量检查记录.md'),
    '# 质量检查记录\n\n已按 V7 必须成果清单核对目录、对应关系和可编辑派生文件。禁止生成 V6 副本与 page-*.png。\n'
  );
  writeIfMissing(
    path.join(uniqueRoot, '03_网络补充资料与AI核对表.md'),
    '# 网络补充资料与AI核对表\n\n网络资料使用 NET-xxx 独立编号。未取得全文的候选不得写入正式结论。\n'
  );
  writeIfMissing(
    path.join(uniqueRoot, '04_标准版本核验表.md'),
    '# 标准版本核验表\n\n记录标准号、当前状态、新标准、实施日期、官方链接和核验日期。结构化数据以 standard_monitor.json 为准。\n'
  );
  writeIfMissing(
    path.join(taskDir, '00_项目总体', '03_资料总清单与阅读日志', '阅读日志.md'),
    '# 阅读日志\n\n按资料 ID 记录阅读顺序、文种和是否已形成三类总结。\n'
  );

  const denseFiles = listMarkdownFiles(path.join(uniqueRoot, '01_高密度单篇总结_V7'));
  const onePageFiles = listMarkdownFiles(path.join(uniqueRoot, '02_一页版'));
  const writeCompilation = (file: string, content: string, hasSource: boolean) => {
    if (hasSource || !fs.existsSync(file)) {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    }
  };
  writeCompilation(
    path.join(formal, '单篇资料高密度总结汇编.md'),
    assembleCompilation('单篇资料高密度总结汇编', denseFiles),
    denseFiles.length > 0
  );
  writeCompilation(
    path.join(formal, '一页总结汇编.md'),
    assembleCompilation('一页总结汇编', onePageFiles),
    onePageFiles.length > 0
  );
  writeCompilation(path.join(formal, '详细证据附件.md'), assembleDetailedEvidence(taskDir), denseFiles.length > 0);
  writeIfMissing(path.join(formal, '待补证清单.md'), defaultPendingList(taskDir));
  if (!fs.existsSync(path.join(formal, '决策版研究综述.md'))) {
    const firstReview = listTopicFolders(taskDir)
      .map((topic) => listMarkdownFiles(path.join(topic.dir, '04_单课题综述'))[0])
      .find(Boolean);
    writeIfMissing(
      path.join(formal, '决策版研究综述.md'),
      firstReview
        ? `# 决策版研究综述\n\n${readText(firstReview).replace(/^# .+\n+/, '')}`
        : '# 决策版研究综述\n\n待按课题综述压缩决策版。\n'
    );
  }
  writeIfMissing(
    path.join(formal, '编制说明与质量检查报告.md'),
    `# 编制说明与质量检查报告\n\n- 唯一高密度总结：${denseFiles.length} 份\n- 课题文件夹：${listTopicFolders(taskDir).length} 个\n- 正式成果以 Markdown / JSON 为源，DOCX / XLSX 为可编辑派生。\n- 未生成 V6 历史副本、page-*.png 或 contact sheet。\n`
  );

  syncTopicCopies(taskDir);
  await writeFormalAndTopicDocx(taskDir);
  try {
    await writeEvidenceWorkbook(taskDir);
  } catch (error) {
    fs.writeFileSync(
      path.join(formal, '证据台账生成说明.md'),
      `# 证据台账\n\nExcel 派生成果未能写入：${error instanceof Error ? error.message : String(error)}\n`,
      'utf8'
    );
  }
}

export function summarizeDerived(taskDir: string) {
  const titles = listMarkdownFiles(
    path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充', '01_高密度单篇总结_V7')
  ).map((file) => firstHeading(readText(file), path.basename(file, '.md')));
  return {
    denseTitles: titles.slice(0, 8),
    topicNames: listTopicFolders(taskDir).map((item) => item.name)
  };
}
