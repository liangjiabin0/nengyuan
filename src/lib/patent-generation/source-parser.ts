import path from 'node:path';
import JSZip from 'jszip';
import { convertMathTypeOleToLatex } from './mtef';
import type {
  PatentFigure,
  PatentFormula,
  PatentParsedSource,
  PatentTable
} from './types';

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

function decodeXml(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return XML_ENTITIES[entity.toLowerCase()] || '';
  });
}

function normalizeText(value: string) {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function textFromXml(fragment: string) {
  const tokens = [
    ...fragment.matchAll(
      /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\s*\/>|<w:br(?:\s[^>]*)?\s*\/>/g
    )
  ].map((match) => {
    if (match[1] !== undefined) return decodeXml(match[1]);
    return /^<w:tab/.test(match[0]) ? '\t' : '\n';
  });
  return normalizeText(tokens.join(''));
}

function extractRelationshipMap(xml: string) {
  const relationships = new Map<string, { target: string; type: string }>();
  for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/g)) {
    const attrs = match[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    const type = /\bType="([^"]+)"/.exec(attrs)?.[1] || '';
    if (id && target) relationships.set(id, { target, type });
  }
  return relationships;
}

function extensionMediaType(target: string) {
  const extension = path.extname(target).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.wmf') return 'image/wmf';
  if (extension === '.emf') return 'image/emf';
  return 'application/octet-stream';
}

function relationshipZipPath(target: string) {
  const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('word/')) return normalized;
  const parts = ['word', ...normalized.split('/')];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

function inferMetadata(paragraphs: string[]) {
  const compact = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  const lines = compact
    .slice(0, 12)
    .flatMap((paragraph) => paragraph.split('\n'))
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const titleIndex = lines.findIndex((line) =>
    line.length >= 8
    && line.length <= 80
    && !/^(第\s*\d+\s*卷|Vol\.|20\d{2}\s*年|基金项目|National Natural|DOI|Abstract|摘要|关键词|Keywords|中图分类号|文章编号|文献标志码|学科代码)/i.test(line)
    && /[\u3400-\u9fff]/.test(line)
    && !/[。；;：:]$/.test(line)
  );
  const title = titleIndex >= 0 ? lines[titleIndex] : undefined;
  const abstractLine = lines.find((line) => /^摘\s*要[：:]/.test(line));
  const keywordLine = lines.find((line) => /^关键词[：:]/.test(line));
  const authorLine = titleIndex >= 0
    ? lines.slice(titleIndex + 1, titleIndex + 8).find((line) =>
        /^[\u3400-\u9fff·,\s，、*＊\d]+$/.test(line)
        && /[,，、]/.test(line)
        && /[\u3400-\u9fff]{2,4}/.test(line)
      )
    : undefined;
  const authors = authorLine
    ?.replace(/\d+|[*＊]/g, '')
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => /^[\u3400-\u9fff·]{2,8}$/.test(item));
  const affiliationText = lines
    .slice(Math.max(0, titleIndex + 1), titleIndex + 12)
    .find((line) => /（?\s*1[.．、]/.test(line) && /(大学|研究院|研究所|公司|实验室|学院)/.test(line));
  const organizations = affiliationText
    ? [...affiliationText.matchAll(/(?:^|[；;（(])\s*\d+[.．、]\s*([^；;）)]+)/g)]
        .map((match) => match[1].replace(/，.*$/, '').trim())
        .filter(Boolean)
    : [];
  const firstOrganization = organizations[0] || '';
  const applicant = /.+?大学/.exec(firstOrganization)?.[0]
    || /.+?研究院/.exec(firstOrganization)?.[0]
    || /.+?研究所/.exec(firstOrganization)?.[0]
    || /.+?公司/.exec(firstOrganization)?.[0]
    || firstOrganization
    || undefined;
  return {
    title,
    abstract: abstractLine?.replace(/^摘\s*要[：:]\s*/, ''),
    keywords: keywordLine
      ?.replace(/^关键词[：:]\s*/, '')
      .split(/[；;，,]/)
      .map((item) => item.trim())
      .filter(Boolean),
    authors,
    applicant,
    organizations
  };
}

function parseTables(documentXml: string): PatentTable[] {
  return [...documentXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)].map((tableMatch, tableIndex) => {
    const rows = [...tableMatch[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((rowMatch) =>
      [...rowMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cellMatch) =>
        textFromXml(cellMatch[0]).replace(/\n+/g, ' ').trim()
      )
    );
    const caption = rows[0]?.[0]?.startsWith('表') ? rows[0][0] : '';
    return { id: `T${String(tableIndex + 1).padStart(3, '0')}`, index: tableIndex + 1, caption, rows };
  });
}

function headingLike(paragraph: string) {
  return /^(摘要|Abstract|引言|绪论|结论|参考文献|\d+(?:\.\d+)*\s*[^\n]{1,50}|[一二三四五六七八九十]+、[^\n]{1,50})$/i.test(
    paragraph.trim()
  );
}

async function parseDocx(buffer: Buffer): Promise<PatentParsedSource> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files);
  if (entries.length > 5_000) throw new Error('DOCX 内部文件数量异常，已拒绝解析。');
  const documentEntry = zip.file('word/document.xml');
  if (!documentEntry) throw new Error('DOCX 缺少 word/document.xml。');
  const documentXml = await documentEntry.async('string');
  if (documentXml.length > 50 * 1024 * 1024) {
    throw new Error('DOCX 正文解压后过大，已拒绝解析。');
  }
  const relationshipsXml = await zip.file('word/_rels/document.xml.rels')?.async('string') || '';
  const relationships = extractRelationshipMap(relationshipsXml);
  const paragraphXml = [...documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((match) => match[0]);
  const plainParagraphs = paragraphXml.map(textFromXml);
  const formulas: PatentFormula[] = [];
  const equationProgramIds: Record<string, number> = {};
  let formulaIndex = 0;

  const renderedParagraphs: string[] = [];
  for (let paragraphIndex = 0; paragraphIndex < paragraphXml.length; paragraphIndex += 1) {
    const xml = paragraphXml[paragraphIndex];
    let paragraph = plainParagraphs[paragraphIndex] || '';
    const objects = [...xml.matchAll(/<o:OLEObject\b([^>]+?)\/?>/g)];
    const nativeMath = [...xml.matchAll(/<m:oMath(?:Para)?\b[\s\S]*?<\/m:oMath(?:Para)?>/g)];

    for (const objectMatch of objects) {
      const attrs = objectMatch[1];
      const programId = /\bProgID="([^"]+)"/.exec(attrs)?.[1] || 'unknown';
      equationProgramIds[programId] = (equationProgramIds[programId] || 0) + 1;
      if (!/^Equation\./i.test(programId)) continue;
      formulaIndex += 1;
      const relationshipId = /\br:id="([^"]+)"/.exec(attrs)?.[1];
      const objectId = /\bObjectID="([^"]+)"/.exec(attrs)?.[1];
      const relation = relationshipId ? relationships.get(relationshipId) : undefined;
      let latex = '';
      let confidence: PatentFormula['confidence'] = 'low';
      let warnings: string[] = [];
      if (relation?.target) {
        const entry = zip.file(relationshipZipPath(relation.target));
        if (entry) {
          try {
            const converted = convertMathTypeOleToLatex(await entry.async('nodebuffer'));
            latex = normalizeText(converted.latex);
            confidence = converted.confidence;
            warnings = converted.warnings;
          } catch (error) {
            warnings = [error instanceof Error ? error.message : 'MathType 公式解析失败。'];
          }
        } else {
          warnings = [`找不到公式对象 ${relation.target}。`];
        }
      } else {
        warnings = ['公式对象缺少可解析的关系目标。'];
      }
      const id = `F${String(formulaIndex).padStart(3, '0')}`;
      const context = [
        plainParagraphs[paragraphIndex - 1] || '',
        plainParagraphs[paragraphIndex] || '',
        plainParagraphs[paragraphIndex + 1] || ''
      ].filter(Boolean).join(' ').slice(0, 600);
      formulas.push({
        id,
        index: formulaIndex,
        latex,
        confidence,
        context,
        objectId,
        relationshipId,
        warnings
      });
      paragraph += ` [公式 ${id}${latex ? `：${latex}` : '：未恢复'}]`;
    }

    for (const mathMatch of nativeMath) {
      formulaIndex += 1;
      const id = `F${String(formulaIndex).padStart(3, '0')}`;
      const fallback = [...mathMatch[0].matchAll(/<m:t(?:\s[^>]*)?>([\s\S]*?)<\/m:t>/g)]
        .map((match) => decodeXml(match[1]))
        .join('');
      formulas.push({
        id,
        index: formulaIndex,
        latex: fallback,
        confidence: fallback ? 'medium' : 'low',
        context: paragraph.slice(0, 600),
        warnings: fallback ? ['原生 OMML 公式以线性文本恢复。'] : ['原生 OMML 公式未恢复。']
      });
      paragraph += ` [公式 ${id}${fallback ? `：${fallback}` : '：未恢复'}]`;
    }
    const normalized = normalizeText(paragraph);
    if (normalized) renderedParagraphs.push(normalized);
  }

  const tables = parseTables(documentXml);
  const imageRelations = [...relationships.entries()].filter(([, relation]) =>
    /\/image$/i.test(relation.type) || /\.(png|jpe?g|gif|svg|wmf|emf)$/i.test(relation.target)
  );
  const captions = renderedParagraphs.filter((paragraph) => /^图\s*\d+/i.test(paragraph));
  const drawingRelationships = [...documentXml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)]
    .map((match) => /\br:(?:embed|id)="([^"]+)"/.exec(match[0])?.[1]);
  const drawingRelationshipIds = drawingRelationships.filter(
    (relationshipId): relationshipId is string => Boolean(relationshipId)
  );
  const documentWithoutOleObjects = documentXml.replace(/<w:object\b[\s\S]*?<\/w:object>/g, '');
  const legacyImageRelationships = [...documentWithoutOleObjects.matchAll(/<v:imagedata\b[^>]*\br:id="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((relationshipId) => !drawingRelationshipIds.includes(relationshipId));
  const referencedFigures: Array<string | undefined> = [...drawingRelationships, ...legacyImageRelationships];
  const figureRelationships = referencedFigures.length
    ? referencedFigures.map((relationshipId) => [
        relationshipId,
        relationshipId ? relationships.get(relationshipId) : undefined
      ] as const)
    : imageRelations.filter(([, relation]) => !/\.wmf$/i.test(relation.target));
  const figures: PatentFigure[] = figureRelationships
    .map(([relationshipId, relation], index) => ({
      id: `D${String(index + 1).padStart(3, '0')}`,
      index: index + 1,
      caption: captions[index] || '',
      relationshipId: relationshipId || undefined,
      target: relation?.target ? relationshipZipPath(relation.target) : undefined,
      mediaType: relation?.target ? extensionMediaType(relation.target) : undefined
    }));
  for (let index = figures.length; index < captions.length; index += 1) {
    figures.push({
      id: `D${String(index + 1).padStart(3, '0')}`,
      index: index + 1,
      caption: captions[index]
    });
  }
  const tablesText = tables
    .map((table) => [
      `## 表格 ${table.id}${table.caption ? `：${table.caption}` : ''}`,
      ...table.rows.map((row) => row.join(' | '))
    ].join('\n'))
    .join('\n\n');
  const text = normalizeText(`${renderedParagraphs.join('\n\n')}${tablesText ? `\n\n${tablesText}` : ''}`);
  const formulaObjectsRecovered = formulas.filter((formula) =>
    Boolean(formula.latex) && formula.confidence !== 'low'
  ).length;
  const warnings = [
    ...formulas
      .filter((formula) => !formula.latex || formula.confidence === 'low')
      .slice(0, 30)
      .map((formula) => `${formula.id}: ${formula.warnings.join('；') || '公式恢复置信度低。'}`)
  ];
  if (formulaObjectsRecovered < formulas.length) {
    warnings.unshift(`有 ${formulas.length - formulaObjectsRecovered} 个公式未达到可靠恢复标准。`);
  }
  const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir);
  return {
    text,
    charCount: text.length,
    paragraphs: renderedParagraphs,
    headings: renderedParagraphs.filter(headingLike),
    tables,
    figures,
    formulas,
    formulaObjectsDetected: formulas.length,
    formulaObjectsRecovered,
    warnings,
    metadata: {
      ...inferMetadata(renderedParagraphs),
      mediaCount: mediaFiles.length,
      imageCount: figures.length,
      equationProgramIds
    }
  };
}

async function parsePdf(buffer: Buffer): Promise<PatentParsedSource> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = normalizeText(result.text || '');
    if (text.length < 50) throw new Error('PDF 未提取到足够文本，扫描版文档需要先执行 OCR。');
    const paragraphs = text.split(/\n\s*\n/g).map(normalizeText).filter(Boolean);
    return {
      text,
      charCount: text.length,
      paragraphs,
      headings: paragraphs.filter(headingLike),
      tables: [],
      figures: [],
      formulas: [],
      formulaObjectsDetected: 0,
      formulaObjectsRecovered: 0,
      warnings: ['PDF 仅提取文本层，复杂公式和图表需人工复核。'],
      metadata: { ...inferMetadata(paragraphs), imageCount: 0 }
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export async function parsePatentSource(
  fileName: string,
  buffer: Buffer
): Promise<PatentParsedSource> {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.docx') {
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error('文件扩展名为 DOCX，但内容不是有效的 Office 文档。');
    }
    return parseDocx(buffer);
  }
  if (extension === '.pdf') {
    if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('文件扩展名为 PDF，但内容不是有效的 PDF 文档。');
    }
    return parsePdf(buffer);
  }
  if (['.md', '.markdown', '.txt', '.rtf', '.tex', '.html', '.htm'].includes(extension)) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
    const nullRatio = sample.length
      ? [...sample].filter((value) => value === 0).length / sample.length
      : 0;
    if (nullRatio > 0.01) throw new Error('文本文件疑似为二进制内容，无法安全解析。');
    const text = normalizeText(buffer.toString('utf8'));
    if (!text) throw new Error('技术文档为空。');
    const paragraphs = text.split(/\n\s*\n/g).map(normalizeText).filter(Boolean);
    return {
      text,
      charCount: text.length,
      paragraphs,
      headings: paragraphs.filter(headingLike),
      tables: [],
      figures: [],
      formulas: [],
      formulaObjectsDetected: 0,
      formulaObjectsRecovered: 0,
      warnings: [],
      metadata: inferMetadata(paragraphs)
    };
  }
  throw new Error('仅支持 DOCX、PDF、Markdown/TXT/RTF/HTML/TeX 技术文档。');
}
