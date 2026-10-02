import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx';
import type { GridGuideDocument } from './types';

const FONT = '宋体';
const SIZE = 24;

function run(text: string, options: { bold?: boolean; size?: number; font?: string } = {}) {
  return new TextRun({
    text,
    bold: options.bold,
    size: options.size || SIZE,
    font: options.font || FONT
  });
}

function title(text: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 320 },
    children: [run(text, { bold: true, size: 32, font: '方正小标宋简体' })]
  });
}

function heading(text: string) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 180, after: 80 },
    children: [run(text, { bold: true, size: 28, font: '黑体' })]
  });
}

function subheading(text: string) {
  return new Paragraph({
    spacing: { before: 140, after: 60 },
    children: [run(text, { bold: true, size: 24, font: '黑体' })]
  });
}

function body(text: string) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 480 },
    spacing: { line: 360, after: 40 },
    children: [run(text)]
  });
}

function bodyParagraphs(text: string) {
  const parts = text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((part) => part.replace(/^[　\s]+/, '').trim())
    .filter(Boolean);
  return (parts.length ? parts : [text.trim() || '']).map(body);
}

function item(text: string, index: number, style: 'arabic' | 'paren' = 'paren') {
  const marker = style === 'arabic' ? `${index}.` : `（${index}）`;
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { left: style === 'arabic' ? 240 : 480, hanging: 0 },
    spacing: { line: 340, after: 30 },
    children: [run(`${marker}${text}`)]
  });
}

function tableCell(text: string, bold = false) {
  return new TableCell({
    margins: { top: 100, bottom: 100, left: 100, right: 100 },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [run(text, { bold, size: 20 })]
      })
    ]
  });
}

export async function buildGridGuideDocx(document: GridGuideDocument) {
  const guide = document.guide;
  const explanation = document.explanation;
  const children: Array<Paragraph | Table> = [
    title(`《${document.projectTitle}》项目申报指南`),
    heading('一、技术类别'),
    ...bodyParagraphs(guide.technicalCategory),
    heading('二、总体目标'),
    ...bodyParagraphs(guide.overallObjective),
    heading('三、课题设置情况'),
    ...guide.topicSetup.map((value, index) => item(value, index + 1, 'arabic')),
    heading('四、项目实施期限'),
    ...bodyParagraphs(guide.implementationPeriod),
    heading('五、课题内容')
  ];

  guide.topics.forEach((topic, topicIndex) => {
    children.push(subheading(`课题${topicIndex + 1}：${topic.title}`));
    children.push(subheading('主要研究内容：'));
    children.push(...topic.researchContent.map((value, index) => item(value, index + 1)));
    children.push(subheading('预期目标：'));
    children.push(...bodyParagraphs(topic.expectedGoal));
    children.push(subheading('考核指标：'));
    children.push(...topic.assessmentIndicators.map((value, index) => item(value, index + 1)));
  });

  children.push(
    heading('六、技术成熟度及成果应用'),
    ...bodyParagraphs(guide.maturityAndApplication),
    heading('七、支持经费限额'),
    ...bodyParagraphs(guide.budgetLimit),
    new Paragraph({ children: [new PageBreak()] }),
    title(`《${document.projectTitle}》项目申报指南编制说明`),
    heading('一、技术需求分析'),
    ...bodyParagraphs(explanation.technicalDemandAnalysis),
    heading('二、技术现状分析及需要开展的研究工作'),
    ...bodyParagraphs(explanation.currentStatusAndResearchWork),
    heading('三、课题设置说明'),
    ...bodyParagraphs(explanation.topicSetupExplanation),
    heading('四、项目与规划/需求的对应性'),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
        left: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
        right: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'B0B0B0' },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'B0B0B0' }
      },
      rows: [
        new TableRow({
          children: ['指南名称', '规划/需求编号', '规划/需求名称', '技术领域', '提出单位']
            .map((value) => tableCell(value, true))
        }),
        new TableRow({
          children: [
            explanation.planningCorrespondence.guideName,
            explanation.planningCorrespondence.requirementNumber,
            explanation.planningCorrespondence.requirementName,
            explanation.planningCorrespondence.technicalField,
            explanation.planningCorrespondence.proposingUnit
          ].map((value) => tableCell(value))
        })
      ]
    }),
    heading('五、承担主体及说明'),
    ...bodyParagraphs(explanation.undertakingEntity)
  );

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: SIZE },
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
      children
    }]
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export function gridGuideFileName(title: string) {
  return `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}-项目指南及编制说明.docx`;
}
