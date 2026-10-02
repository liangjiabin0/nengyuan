import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import {
  inspectRenderedDiagram,
  renderDiagramPng,
  renderDiagramSvg
} from './diagram-renderer';
import type {
  InventionDisclosure,
  PatentDiagramSpec,
  PatentDrawingAsset,
  PatentFigure,
  ClaimStrategy
} from './types';

export {
  inspectRenderedDiagram,
  renderDiagramPng,
  renderDiagramSvg
} from './diagram-renderer';

const EMBEDDABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg']);
const SKIP_EXTENSIONS = new Set(['.wmf', '.emf']);

async function writeFileAtomic(filePath: string, data: string | Buffer) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, filePath);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 无第三方依赖的 RGB PNG 编码器，用于专利线稿回退图。 */
export function encodePngRgb(width: number, height: number, rgb: Buffer) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    rgb.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function mediaTypeToDocxType(mediaType?: string, fileName?: string): 'png' | 'jpg' | 'gif' | 'bmp' | 'svg' | null {
  const extension = path.extname(fileName || '').toLowerCase();
  const value = (mediaType || '').toLowerCase();
  if (value.includes('png') || extension === '.png') return 'png';
  if (value.includes('jpeg') || value.includes('jpg') || extension === '.jpg' || extension === '.jpeg') return 'jpg';
  if (value.includes('gif') || extension === '.gif') return 'gif';
  if (value.includes('bmp') || extension === '.bmp') return 'bmp';
  if (value.includes('svg') || extension === '.svg') return 'svg';
  return null;
}

export async function readPngSize(buffer: Buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return null;
}

export async function readJpegSize(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const size = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + size;
  }
  return null;
}

export async function probeImageSize(buffer: Buffer, type: 'png' | 'jpg' | 'gif' | 'bmp' | 'svg') {
  if (type === 'png') return (await readPngSize(buffer)) || { width: 900, height: 640 };
  if (type === 'jpg') return (await readJpegSize(buffer)) || { width: 900, height: 640 };
  if (type === 'svg') {
    const text = buffer.toString('utf8');
    const viewBox = /viewBox="0 0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/.exec(text);
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
    const width = /width="(\d+(?:\.\d+)?)"/.exec(text);
    const height = /height="(\d+(?:\.\d+)?)"/.exec(text);
    if (width && height) return { width: Number(width[1]), height: Number(height[1]) };
  }
  return { width: 900, height: 640 };
}

export async function extractSourceFigures(input: {
  projectDir: string;
  sourcePath: string;
  figures: PatentFigure[];
}) {
  const figuresDir = path.join(input.projectDir, 'figures');
  await fs.mkdir(figuresDir, { recursive: true });
  const sourceBuffer = await fs.readFile(input.sourcePath);
  const zip = await JSZip.loadAsync(sourceBuffer);
  const assets: PatentDrawingAsset[] = [];
  let figureNumber = 0;
  for (const figure of input.figures) {
    if (!figure.target) continue;
    const extension = path.extname(figure.target).toLowerCase();
    if (SKIP_EXTENSIONS.has(extension) || !EMBEDDABLE_EXTENSIONS.has(extension)) continue;
    const entry = zip.file(figure.target);
    if (!entry) continue;
    const data = Buffer.from(await entry.async('nodebuffer'));
    if (data.length < 32) continue;
    figureNumber += 1;
    const fileName = `图${figureNumber}${extension}`;
    const relativePath = path.join('figures', fileName);
    await writeFileAtomic(path.join(input.projectDir, relativePath), data);
    const docxType = mediaTypeToDocxType(figure.mediaType, fileName);
    assets.push({
      id: figure.id || `SRC-${figureNumber}`,
      figureNumber,
      caption: figure.caption || `图${figureNumber}`,
      source: 'extracted',
      fileName,
      relativePath: relativePath.replace(/\\/g, '/'),
      mediaType: figure.mediaType || `image/${extension.slice(1)}`,
      docxType: docxType || 'png',
      widthPx: (await probeImageSize(data, docxType || 'png')).width,
      heightPx: (await probeImageSize(data, docxType || 'png')).height
    });
  }
  return assets;
}

export function buildFallbackDiagramSpecs(
  disclosure: InventionDisclosure,
  strategy?: ClaimStrategy | null
): PatentDiagramSpec[] {
  const features = [
    ...disclosure.essentialFeatures.slice(0, 6),
    ...disclosure.optionalFeatures.slice(0, 2)
  ];
  const processNodes = (features.length
    ? features.slice(0, 5).map((feature, index) => ({
        id: `N${index + 2}`,
        label: feature.name || `步骤${index + 1}`,
        ref: String(102 + index)
      }))
    : [
        { id: 'N2', label: '输入采集', ref: '102' },
        { id: 'N3', label: '核心处理', ref: '103' },
        { id: 'N4', label: '约束求解', ref: '104' },
        { id: 'N5', label: '结果输出', ref: '105' }
      ]);
  const flowNodes = [
    { id: 'N1', label: '开始', ref: '101' },
    ...processNodes,
    { id: `N${processNodes.length + 2}`, label: '结束', ref: String(102 + processNodes.length) }
  ];
  const flowEdges = flowNodes.slice(0, -1).map((node, index) => ({
    from: node.id,
    to: flowNodes[index + 1].id
  }));
  const middleModules = features.length >= 3
    ? features.slice(0, 4).map((feature, index) => ({
        id: `S${index + 2}`,
        label: /模块$/.test(feature.name) ? feature.name : `${feature.name}模块`,
        ref: String(202 + index)
      }))
    : [
        { id: 'S2', label: '数据采集模块', ref: '202' },
        { id: 'S3', label: '协同建模模块', ref: '203' },
        { id: 'S4', label: '约束求解模块', ref: '204' }
      ];
  const systemNodes = [
    { id: 'S1', label: '协同调度控制中心', ref: '201' },
    ...middleModules,
    {
      id: `S${middleModules.length + 2}`,
      label: '调度输出模块',
      ref: String(202 + middleModules.length)
    }
  ];
  const systemEdges = [
    ...middleModules.map((node) => ({ from: 'S1', to: node.id })),
    ...middleModules.map((node) => ({ from: node.id, to: systemNodes[systemNodes.length - 1].id }))
  ];
  const dataLabels = [
    ...disclosure.inputs.slice(0, 2),
    ...features.slice(0, 3).map((feature) => feature.name),
    ...disclosure.outputs.slice(0, 2)
  ].filter(Boolean);
  const dataNodes = (dataLabels.length >= 3
    ? dataLabels
    : ['输入数据', '时空特征数据', '协同优化数据', '调度结果']
  ).slice(0, 6).map((label, index) => ({
    id: `E${index + 1}`,
    label,
    ref: String(301 + index)
  }));
  const titleBase = strategy?.inventionTitle || disclosure.proposedTitle || '本发明';
  const specs: PatentDiagramSpec[] = [
    {
      figureNumber: 1,
      title: `图1 ${titleBase}方法流程图`,
      kind: 'flowchart',
      nodes: flowNodes,
      edges: flowEdges
    },
    {
      figureNumber: 2,
      title: `图2 ${titleBase}系统结构图`,
      kind: 'block',
      nodes: systemNodes,
      edges: systemEdges
    },
    {
      figureNumber: 3,
      title: `图3 ${titleBase}数据流图`,
      kind: 'structure',
      nodes: dataNodes,
      edges: dataNodes.slice(0, -1).map((node, index) => ({
        from: node.id,
        to: dataNodes[index + 1].id
      }))
    }
  ];
  return specs;
}

/** 附图节点过长时压缩标签，避免线稿质检因文字溢出失败。 */
export function compactDiagramSpec(spec: PatentDiagramSpec, maxChars = 8): PatentDiagramSpec {
  const shortTitle = (() => {
    const raw = String(spec.title || '').trim();
    if (/^图\d+\s/.test(raw) && raw.length <= 16) return raw;
    if (spec.kind === 'flowchart') return `图${spec.figureNumber} 方法流程图`;
    if (spec.kind === 'block') return `图${spec.figureNumber} 系统结构图`;
    return `图${spec.figureNumber} 数据流图`;
  })();
  return {
    ...spec,
    title: shortTitle,
    nodes: (spec.nodes || []).map((node) => {
      const label = String(node.label || '')
        .replace(/\s+/g, '')
        .replace(/(模块|单元|装置|系统|步骤|方法|流程)$/u, '')
        .replace(/[…·•]+/g, '')
        .trim();
      const clipped = label.length > maxChars ? label.slice(0, maxChars) : label;
      return {
        ...node,
        label: clipped || node.id.slice(0, maxChars)
      };
    }),
    edges: (spec.edges || []).map((edge) => ({
      ...edge,
      label: edge.label && edge.label.length > 6 ? edge.label.slice(0, 6) : edge.label
    }))
  };
}

export async function persistGeneratedDiagrams(input: {
  projectDir: string;
  specs: PatentDiagramSpec[];
  startFigureNumber?: number;
}) {
  const figuresDir = path.join(input.projectDir, 'figures');
  await fs.mkdir(figuresDir, { recursive: true });
  const start = input.startFigureNumber || 1;
  const assets: PatentDrawingAsset[] = [];
  for (const [index, spec] of input.specs.entries()) {
    const figureNumber = start + index;
    let normalized: PatentDiagramSpec = compactDiagramSpec({ ...spec, figureNumber }, 8);
    let svg = renderDiagramSvg(normalized);
    let png = await renderDiagramPng(normalized);
    let inspection = await inspectRenderedDiagram(normalized, png, svg);
    if (!inspection.passed) {
      // 再压缩一轮后重试，避免 OpenCode 长模块名直接导致整单失败
      normalized = compactDiagramSpec({ ...spec, figureNumber }, 6);
      svg = renderDiagramSvg(normalized);
      png = await renderDiagramPng(normalized);
      inspection = await inspectRenderedDiagram(normalized, png, svg);
    }
    if (!inspection.passed) {
      throw new Error(`图${figureNumber}附图质量检查未通过：${inspection.issues.join('；')}`);
    }
    const baseName = `图${figureNumber}`;
    const svgName = `${baseName}.svg`;
    const pngName = `${baseName}.png`;
    await writeFileAtomic(path.join(figuresDir, svgName), svg);
    await writeFileAtomic(path.join(figuresDir, pngName), png);
    const size = await probeImageSize(png, 'png');
    assets.push({
      id: `GEN-${figureNumber}`,
      figureNumber,
      caption: normalized.title.startsWith('图') ? normalized.title : `图${figureNumber} ${normalized.title}`,
      source: 'generated',
      fileName: pngName,
      relativePath: `figures/${pngName}`,
      svgRelativePath: `figures/${svgName}`,
      mediaType: 'image/png',
      docxType: 'png',
      widthPx: size.width,
      heightPx: size.height,
      diagram: normalized
    });
  }
  return assets;
}

export async function loadDrawingBuffers(projectDir: string, assets: PatentDrawingAsset[]) {
  const result: Array<PatentDrawingAsset & {
    data: Buffer;
    svgData?: Buffer;
    fallbackData?: Buffer;
  }> = [];
  for (const asset of assets) {
    const absolute = path.join(projectDir, asset.relativePath);
    const data = await fs.readFile(absolute);
    const svgData = asset.svgRelativePath
      ? await fs.readFile(path.join(projectDir, asset.svgRelativePath)).catch(() => undefined)
      : undefined;
    let fallbackData: Buffer | undefined;
    if (asset.docxType === 'svg') {
      const pngPath = asset.svgRelativePath
        ? path.join(projectDir, asset.svgRelativePath.replace(/\.svg$/i, '.png'))
        : path.join(projectDir, asset.relativePath.replace(/\.svg$/i, '.png'));
      fallbackData = await fs.readFile(pngPath).catch(() => renderDiagramPng(asset.diagram || {
        figureNumber: asset.figureNumber,
        title: asset.caption,
        kind: 'block',
        nodes: [{ id: 'N1', label: asset.caption, ref: String(asset.figureNumber) }],
        edges: []
      }));
    }
    result.push({
      ...asset,
      data,
      svgData,
      fallbackData: asset.docxType === 'svg' ? fallbackData : data
    });
  }
  return result;
}

export function drawingDescriptionFromAssets(assets: PatentDrawingAsset[]) {
  if (!assets.length) return '无';
  return assets
    .slice()
    .sort((left, right) => left.figureNumber - right.figureNumber)
    .map((asset) => {
      const caption = asset.caption.replace(/^图\s*\d+[：:\s]*/, '');
      const refs = asset.diagram?.nodes
        .map((node) => (node.ref ? `${node.ref} ${node.label}` : node.label))
        .filter(Boolean)
        .join('；');
      return refs
        ? `图${asset.figureNumber}为${caption || '本发明示意图'}。图中：${refs}。`
        : `图${asset.figureNumber}为${caption || '本发明示意图'}。`;
    })
    .join('\n');
}
