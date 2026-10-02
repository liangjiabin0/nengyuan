import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  TextRun
} from 'docx';
import { buildMathAwareParagraphs, ensureDocxMathSettings } from './docx-math';
import {
  loadDrawingBuffers,
  probeImageSize
} from './figures';
import { getPatentProjectDirectory } from './store';
import type { PatentDrawingAsset, PatentProject } from './types';
import { splitClaims } from './validators';

const BODY_FONT = '宋体';
const BODY_SIZE = 24;

function bodyParagraph(text: string, options: { firstLine?: boolean; bold?: boolean } = {}) {
  const mathAware = buildMathAwareParagraphs(text, {
    firstLine: options.firstLine,
    bold: options.bold
  });
  if (mathAware.length) return mathAware[0]!;
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: options.firstLine ? { firstLine: 480 } : undefined,
    spacing: { line: 360, after: 120 },
    children: [
      new TextRun({
        text,
        font: BODY_FONT,
        size: BODY_SIZE,
        bold: options.bold
      })
    ]
  });
}

function heading(text: string, level: 1 | 2 = 1) {
  return new Paragraph({
    heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    alignment: level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: level === 1 ? 240 : 160, after: 160 },
    children: [
      new TextRun({
        text,
        font: level === 1 ? '黑体' : BODY_FONT,
        size: level === 1 ? 32 : 26,
        bold: true
      })
    ]
  });
}

function textParagraphs(value: string) {
  return buildMathAwareParagraphs(value, { firstLine: true });
}

function safeFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, '').slice(0, 80) || '中国发明专利申请';
}

function fitImageSize(widthPx: number, heightPx: number, maxWidth = 640, maxHeight = 820) {
  const scale = Math.min(maxWidth / Math.max(widthPx, 1), maxHeight / Math.max(heightPx, 1), 1);
  return {
    width: Math.max(180, Math.round(widthPx * scale)),
    height: Math.max(120, Math.round(heightPx * scale))
  };
}

async function buildDrawingParagraphs(project: PatentProject) {
  const assets = project.drawings?.assets || project.draft?.drawings || [];
  if (!assets.length) {
    return [bodyParagraph('（本草稿尚未包含说明书附图文件，请重新执行生成流程。）')];
  }
  const projectDir = getPatentProjectDirectory(project.id);
  const loaded = await loadDrawingBuffers(projectDir, assets);
  const paragraphs: Paragraph[] = [];
  for (const asset of loaded) {
    const size = fitImageSize(asset.widthPx || 1600, asset.heightPx || 1120);
    try {
      if (asset.svgData) {
        const fallback = asset.fallbackData || asset.data;
        const fallbackSize = await probeImageSize(fallback, 'png');
        const fitted = fitImageSize(fallbackSize.width, fallbackSize.height);
        paragraphs.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 160, after: 60 },
          children: [
            new ImageRun({
              type: 'svg',
              data: asset.svgData,
              transformation: { width: fitted.width, height: fitted.height },
              fallback: {
                type: 'png',
                data: fallback
              }
            })
          ]
        }));
      } else {
        const rasterType = asset.docxType === 'svg' ? 'png' : asset.docxType;
        paragraphs.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 160, after: 60 },
          children: [
            new ImageRun({
              type: rasterType,
              data: asset.data,
              transformation: { width: size.width, height: size.height },
              altText: {
                title: asset.caption,
                description: asset.caption,
                name: asset.fileName
              }
            })
          ]
        }));
      }
    } catch {
      paragraphs.push(bodyParagraph(`（附图文件 ${asset.fileName} 嵌入失败，请查看压缩包内说明书附图目录。）`));
    }
    paragraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: asset.caption,
          font: BODY_FONT,
          size: 21
        })
      ]
    }));
  }
  return paragraphs;
}

export async function buildPatentDocx(project: PatentProject) {
  if (!project.draft) throw new Error('专利草稿尚未生成。');
  const draft = project.draft;
  const claims = splitClaims(draft.claims);
  const drawingParagraphs = await buildDrawingParagraphs(project);
  const children = [
    heading(draft.title),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [new TextRun({ text: '中国发明专利申请文件草稿', font: '黑体', size: 24 })]
    }),
    bodyParagraph(`申请人：${project.applicant || '待确认'}`),
    bodyParagraph(`发明人：${project.inventors.join('、') || '待确认'}`),
    ...(project.status === 'review_required' || (project.audit && !project.audit.passed)
      ? [bodyParagraph('状态：待人工复核草稿，不得直接提交。', { bold: true })]
      : []),
    new Paragraph({ children: [new PageBreak()] }),
    heading('权利要求书'),
    ...(claims.length
      ? claims.flatMap((claim) => buildMathAwareParagraphs(claim.text, {
          claimPrefix: `${claim.number}. `
        }))
      : textParagraphs(draft.claims)),
    new Paragraph({ children: [new PageBreak()] }),
    heading('说明书'),
    heading('技术领域', 2),
    ...textParagraphs(draft.technicalField),
    heading('背景技术', 2),
    ...textParagraphs(draft.backgroundArt),
    heading('发明内容', 2),
    ...textParagraphs(draft.inventionSummary),
    heading('附图说明', 2),
    ...textParagraphs(draft.drawingDescription || '无'),
    heading('具体实施方式', 2),
    ...textParagraphs(draft.embodiments),
    new Paragraph({ children: [new PageBreak()] }),
    heading('说明书附图'),
    ...drawingParagraphs,
    new Paragraph({ children: [new PageBreak()] }),
    heading('说明书摘要'),
    ...textParagraphs(draft.abstract),
    bodyParagraph(`摘要附图：${draft.abstractFigure || '无'}`)
  ];

  const document = new Document({
    creator: '能元·AI4ES·专利生成',
    title: draft.title,
    description: '中国发明专利申请文件草稿，提交前须由申请人或专利代理师复核。',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE },
          paragraph: { spacing: { line: 360 } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: '第 ', font: BODY_FONT, size: 18 }),
                new TextRun({ children: [PageNumber.CURRENT], font: BODY_FONT, size: 18 }),
                new TextRun({ text: ' 页', font: BODY_FONT, size: 18 })
              ]
            })
          ]
        })
      },
      children
    }]
  });
  const packed = await Packer.toBuffer(document);
  return ensureDocxMathSettings(Buffer.from(packed));
}

function priorArtMarkdown(project: PatentProject) {
  const report = project.priorArt;
  if (!report) return '# 现有技术比对\n\n尚未生成。';
  return [
    '# 现有技术比对',
    '',
    '本报告用于撰写辅助，不等同于正式查新、无效检索或自由实施分析。',
    '',
    '## 检索式',
    ...report.queries.map((query) => `- ${query}`),
    '',
    '## 候选文件',
    ...report.candidates.flatMap((candidate, index) => [
      `### ${index + 1}. ${candidate.title}`,
      `- 公开号：${candidate.publicationNumber || '未提取'}`,
      `- 风险：${candidate.risk}`,
      `- 共同特征：${candidate.commonFeatures.join('、') || '待核对'}`,
      `- 区别特征：${candidate.distinguishingFeatures.join('、') || '待核对'}`,
      `- 说明：${candidate.riskReason}`,
      candidate.url ? `- 来源：${candidate.url}` : '',
      ''
    ]),
    '## 检索限制',
    ...report.searchLimitations.map((limitation) => `- ${limitation}`)
  ].filter(Boolean).join('\n');
}

function qualityMarkdown(project: PatentProject) {
  const audit = project.audit;
  if (!audit) return '# 质量报告\n\n尚未完成审校。';
  return [
    '# 专利申请文件质量报告',
    '',
    `- 质量评分：${audit.score}/100`,
    `- 自动审校：${audit.passed ? '通过' : '未通过，不能视为终稿'}`,
    `- 修复轮次：${audit.rounds}`,
    '',
    '## 规则检查与模型复核',
    ...[...audit.deterministicIssues, ...audit.modelIssues].map((item) =>
      `- [${item.severity}] ${item.category}：${item.message}${item.location ? `（${item.location}）` : ''}`
    ),
    '',
    '## 权利要求支持矩阵',
    ...audit.supportMatrix.map((item) =>
      `- 权利要求${item.claim}：${item.supported ? '有支持' : '待复核'}；证据=${item.evidence.join('、') || '无'}；${item.note}`
    ),
    '',
    '## 剩余风险',
    ...(audit.remainingRisks.length ? audit.remainingRisks.map((risk) => `- ${risk}`) : ['- 无自动识别风险；仍建议专利代理师提交前复核。'])
  ].join('\n');
}

async function appendDrawingFiles(zip: JSZip, project: PatentProject) {
  const assets = project.drawings?.assets || project.draft?.drawings || [];
  if (!assets.length) return;
  const projectDir = getPatentProjectDirectory(project.id);
  const folder = zip.folder('说明书附图');
  if (!folder) return;
  for (const asset of assets) {
    const absolute = path.join(projectDir, asset.relativePath);
    const data = await fs.readFile(absolute).catch(() => null);
    if (data) folder.file(asset.fileName, data);
    if (asset.svgRelativePath) {
      const svg = await fs.readFile(path.join(projectDir, asset.svgRelativePath)).catch(() => null);
      if (svg) folder.file(path.basename(asset.svgRelativePath), svg);
    }
  }
  folder.file('附图清单.md', [
    '# 说明书附图清单',
    '',
    ...(project.drawings?.notes || []).map((note) => `- ${note}`),
    '',
    ...assets.map((asset: PatentDrawingAsset) =>
      `- 图${asset.figureNumber}（${asset.source === 'extracted' ? '源文档提取' : '系统生成'}）：${asset.caption}`
    )
  ].join('\n'));
}

export async function buildPatentExportBundle(project: PatentProject) {
  if (!project.draft) throw new Error('专利草稿尚未生成。');
  const zip = new JSZip();
  const needsReview = project.status === 'review_required' || Boolean(project.audit && !project.audit.passed);
  const baseName = safeFileName(`${project.draft.title}${needsReview ? '-待复核' : ''}`);
  zip.file(`${baseName}-申请文件草稿.docx`, await buildPatentDocx(project));
  zip.file(`${baseName}-现有技术比对.md`, priorArtMarkdown(project));
  zip.file(`${baseName}-质量报告.md`, qualityMarkdown(project));
  zip.file(`${baseName}-发明交底书.json`, JSON.stringify(project.disclosure || {}, null, 2));
  zip.file(`${baseName}-申请信息核对.md`, [
    '# 申请信息核对',
    '',
    `- 申请人：${project.applicant || '待确认'}`,
    `- 发明人：${project.inventors.join('、') || '待确认'}`,
    `- 联系信息：${JSON.stringify(project.contact)}`,
    `- 说明书附图：${(project.drawings?.assets || []).length} 幅`,
    '',
    '该文件包包含权利要求书、说明书、说明书附图与说明书摘要草稿，不是国家知识产权局官方请求书。',
    '正式提交前请使用官方表格核对身份、地址、优先权和代理信息，并由专利代理师复核全部技术内容与附图。'
  ].join('\n'));
  await appendDrawingFiles(zip, project);
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    fileName: `${baseName}-专利申请草稿包.zip`
  };
}
