import sharp from 'sharp';
import type {
  PatentDiagramNode,
  PatentDiagramSpec
} from './types';

/** 逻辑画布尺寸；PNG 按 OUTPUT_SCALE 倍输出，保证打印清晰。 */
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1120;
const OUTPUT_SCALE = 2;
const NODE_STROKE = 2.2;
const LABEL_FONT_SIZE = 22;
const REF_FONT_SIZE = 18;
const FONT_FAMILY = 'DiagramSong, SimSun, Songti SC, Noto Serif CJK SC, serif';
const REF_FONT_FAMILY = 'Times New Roman, DiagramSong, SimSun, serif';
const EMBEDDED_FONT_CSS = `@font-face{font-family:DiagramSong;src:local("SimSun"),local("Songti SC"),url("file:///C:/Windows/Fonts/simsun.ttc");}`;
const REF_COLUMN_WIDTH = 72;
const LABEL_PADDING_X = 52;
const LABEL_PADDING_Y = 28;
const LINE_HEIGHT = 30;
const CANVAS_MARGIN = 72;
/** CJK 实测约 0.99em，这里按 1.08 留余量，避免贴边/溢出。 */
const CJK_WIDTH_FACTOR = 1.08;
const ASCII_WIDTH_FACTOR = 0.7;

type PositionedNode = PatentDiagramNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  shape?: 'rect' | 'stadium';
};

type DiagramLayout = {
  nodes: PositionedNode[];
  ranks: Map<string, number>;
  orientation: 'vertical' | 'horizontal' | 'radial';
};

export type DiagramInspection = {
  passed: boolean;
  issues: string[];
  width: number;
  height: number;
  pngBytes: number;
  inkRatio: number;
  labelledNodes: number;
  totalNodes: number;
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeLabel(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/模块模块/g, '模块')
    .trim();
}

function charWidth(char: string) {
  if (/[，。；：、（）【】《》]/.test(char)) return 0.75;
  return /[\x00-\xff]/.test(char) ? ASCII_WIDTH_FACTOR : CJK_WIDTH_FACTOR;
}

function measureTextUnits(value: string) {
  return Array.from(value).reduce((sum, char) => sum + charWidth(char), 0);
}

function measureTextPixels(value: string, fontSize = LABEL_FONT_SIZE) {
  return measureTextUnits(value) * fontSize;
}

function splitBalanced(label: string, lineCount: number) {
  const characters = Array.from(label);
  if (lineCount <= 1 || characters.length <= 1) return [label];
  const total = measureTextUnits(label);
  const target = total / lineCount;
  const lines: string[] = [];
  let start = 0;
  for (let lineIndex = 0; lineIndex < lineCount - 1; lineIndex += 1) {
    let width = 0;
    let end = start;
    const remainingLines = lineCount - lineIndex;
    const remainingChars = characters.length - start;
    const minLeave = remainingLines - 1;
    while (end < characters.length - minLeave) {
      const next = width + charWidth(characters[end]);
      if (width > 0 && next > target && end > start) break;
      width = next;
      end += 1;
    }
    if (end <= start) end = Math.min(characters.length - minLeave, start + 1);
    lines.push(characters.slice(start, end).join(''));
    start = end;
  }
  lines.push(characters.slice(start).join(''));
  return lines.filter(Boolean);
}

function splitLabel(value: string, maxUnits = 12, maxLines = 3) {
  const label = normalizeLabel(value);
  if (!label) return ['未命名节点'];
  const totalUnits = measureTextUnits(label);
  if (totalUnits <= maxUnits) return [label];

  let lineCount = Math.min(maxLines, Math.max(2, Math.ceil(totalUnits / maxUnits)));
  let lines = splitBalanced(label, lineCount);
  while (lineCount < maxLines && lines.some((line) => measureTextUnits(line) > maxUnits + 0.05)) {
    lineCount += 1;
    lines = splitBalanced(label, lineCount);
  }

  // 避免末行单字孤行：并入上一行；若超宽则改为更均匀的行数
  if (lines.length >= 2 && Array.from(lines[lines.length - 1]).length <= 1) {
    const merged = [...lines];
    const orphan = merged.pop()!;
    merged[merged.length - 1] += orphan;
    if (measureTextUnits(merged[merged.length - 1]) <= maxUnits + 0.8) {
      lines = merged;
    } else if (lines.length < maxLines) {
      lines = splitBalanced(label, lines.length + 1);
    } else {
      lines = splitBalanced(label, Math.max(2, lines.length - 1));
    }
  }

  return lines.filter(Boolean).slice(0, maxLines);
}

function fitLabelLines(label: string, maxLabelPixels: number, maxLines = 3) {
  const normalized = normalizeLabel(label);
  const maxUnits = Math.max(3.5, (maxLabelPixels - 8) / LABEL_FONT_SIZE);
  const totalUnits = measureTextUnits(normalized);
  // 长标签优先两行，避免单行把框撑满后贴边
  const preferredLines = totalUnits <= Math.min(maxUnits, 9.5)
    ? 1
    : totalUnits <= maxUnits * 2
      ? Math.min(maxLines, 2)
      : Math.min(maxLines, 3);
  let lines = preferredLines === 1
    ? [normalized]
    : splitBalanced(normalized, preferredLines);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const widest = Math.max(...lines.map((line) => measureTextPixels(line)));
    if (widest <= maxLabelPixels - 8) break;
    const nextLines = Math.min(maxLines, Math.max(lines.length + 1, 2));
    lines = splitLabel(normalized, Math.max(3.2, maxUnits * (0.9 - attempt * 0.06)), nextLines);
  }
  return lines;
}

function isTerminalLabel(label: string) {
  return /^(开始|结束|返回|终止|启动|停止)$/.test(normalizeLabel(label));
}

function nodeBoxSize(
  lines: string[],
  orientation: 'vertical' | 'horizontal',
  options?: { maxWidth?: number; shape?: 'rect' | 'stadium' }
) {
  const textWidthPx = Math.max(...lines.map((line) => measureTextPixels(line)));
  const stadiumExtra = options?.shape === 'stadium' ? 40 : 0;
  // 左右各留足内边距，宽度至少包住文字，绝不小于内容所需
  const contentWidth = REF_COLUMN_WIDTH + textWidthPx + LABEL_PADDING_X + stadiumExtra + 8;
  const minWidth = orientation === 'vertical' ? 280 : 220;
  const hardMax = options?.maxWidth
    ?? (orientation === 'vertical' ? 620 : 420);
  const width = Math.ceil(Math.min(hardMax, Math.max(minWidth, contentWidth)));
  const height = Math.max(84, lines.length * LINE_HEIGHT + LABEL_PADDING_Y);
  return { width, height, refWidth: REF_COLUMN_WIDTH };
}

function clampNodesToCanvas(
  nodes: PositionedNode[],
  canvasWidth: number,
  canvasHeight: number,
  margin = CANVAS_MARGIN
) {
  return nodes.map((node) => {
    const halfW = node.width / 2;
    const halfH = node.height / 2;
    const minX = margin + halfW;
    const maxX = canvasWidth - margin - halfW;
    const minY = margin + halfH;
    const maxY = canvasHeight - margin - halfH - 24;
    return {
      ...node,
      x: Math.min(Math.max(node.x, minX), Math.max(minX, maxX)),
      y: Math.min(Math.max(node.y, minY), Math.max(minY, maxY))
    };
  });
}

function assignRanks(spec: PatentDiagramSpec) {
  const ids = new Set(spec.nodes.map((node) => node.id));
  const indegree = new Map(spec.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(spec.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of spec.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const ranks = new Map<string, number>();
  const queue = spec.nodes
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .map((node) => node.id);
  for (const id of queue) ranks.set(id, 0);

  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor++];
    for (const target of outgoing.get(id) || []) {
      ranks.set(target, Math.max(ranks.get(target) || 0, (ranks.get(id) || 0) + 1));
      const nextDegree = (indegree.get(target) || 0) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) queue.push(target);
    }
  }

  let fallbackRank = Math.max(0, ...ranks.values());
  for (const node of spec.nodes) {
    if (!ranks.has(node.id)) {
      fallbackRank += 1;
      ranks.set(node.id, fallbackRank);
    }
  }
  return ranks;
}

function layoutLayered(
  spec: PatentDiagramSpec,
  width: number,
  height: number,
  orientation: 'vertical' | 'horizontal'
): DiagramLayout {
  const ranks = assignRanks(spec);
  const groups = new Map<number, PatentDiagramNode[]>();
  for (const node of spec.nodes) {
    const rank = ranks.get(node.id) || 0;
    groups.set(rank, [...(groups.get(rank) || []), node]);
  }
  const levels = [...groups.keys()].sort((left, right) => left - right);
  const marginX = CANVAS_MARGIN;
  const top = CANVAS_MARGIN + 24;
  const bottom = CANVAS_MARGIN + 40;
  const positioned: PositionedNode[] = [];

  levels.forEach((rank, levelIndex) => {
    const items = groups.get(rank) || [];
    const availableRowWidth = width - marginX * 2;
    // 同行节点按实际框宽排布，避免均分中心点导致框体重叠或贴边
    const maxBoxWidth = orientation === 'vertical'
      ? Math.min(620, Math.floor(availableRowWidth / Math.max(items.length, 1) - 28))
      : Math.min(420, Math.floor((width - marginX * 2) / Math.max(levels.length, 1) - 28));
    const maxLabelPixels = Math.max(64, maxBoxWidth - REF_COLUMN_WIDTH - LABEL_PADDING_X);

    const prepared = items.map((node) => {
      const shape = isTerminalLabel(node.label) ? 'stadium' as const : 'rect' as const;
      let lines = fitLabelLines(node.label, maxLabelPixels, 3);
      let box = nodeBoxSize(lines, orientation, { maxWidth: maxBoxWidth, shape });
      const fittedLabelPx = Math.max(48, box.width - REF_COLUMN_WIDTH - LABEL_PADDING_X);
      if (lines.some((line) => measureTextPixels(line) > fittedLabelPx)) {
        lines = fitLabelLines(node.label, fittedLabelPx, 3);
        box = nodeBoxSize(lines, orientation, { maxWidth: maxBoxWidth, shape });
      }
      return { node, shape, lines, box };
    });

    const gap = 28;
    const totalBoxWidth = prepared.reduce((sum, item) => sum + item.box.width, 0);
    const totalGaps = gap * (prepared.length + 1);
    const rowBudget = orientation === 'vertical' ? availableRowWidth : availableRowWidth;
    // 若总宽超出，收紧标签再算一次
    if (orientation === 'vertical' && totalBoxWidth + totalGaps > rowBudget && prepared.length > 0) {
      const tighterMax = Math.max(
        180,
        Math.floor((rowBudget - totalGaps) / prepared.length)
      );
      const tighterLabel = Math.max(48, tighterMax - REF_COLUMN_WIDTH - LABEL_PADDING_X);
      prepared.forEach((item) => {
        item.lines = fitLabelLines(item.node.label, tighterLabel, 3);
        item.box = nodeBoxSize(item.lines, orientation, { maxWidth: tighterMax, shape: item.shape });
      });
    }

    const widths = prepared.map((item) => item.box.width);
    const span = widths.reduce((sum, value) => sum + value, 0) + gap * Math.max(prepared.length - 1, 0);
    let cursor = orientation === 'vertical'
      ? marginX + Math.max(0, (availableRowWidth - span) / 2)
      : 0;

    prepared.forEach((item, itemIndex) => {
      const x = orientation === 'vertical'
        ? cursor + item.box.width / 2
        : levels.length === 1
          ? width / 2
          : marginX + 80 + levelIndex * (width - marginX * 2 - 160) / Math.max(levels.length - 1, 1);
      const y = orientation === 'vertical'
        ? levels.length === 1
          ? height / 2
          : top + levelIndex * (height - top - bottom) / Math.max(levels.length - 1, 1)
        : height * (itemIndex + 1) / (items.length + 1);
      if (orientation === 'vertical') cursor += item.box.width + gap;
      positioned.push({
        ...item.node,
        x: item.node.x ?? x,
        y: item.node.y ?? y,
        width: item.box.width,
        height: item.box.height,
        lines: item.lines,
        shape: item.shape
      });
    });
  });
  return {
    nodes: clampNodesToCanvas(positioned, width, height),
    ranks,
    orientation
  };
}

function selectCentralNode(spec: PatentDiagramSpec) {
  const degree = new Map(spec.nodes.map((node) => [node.id, 0]));
  for (const edge of spec.edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  return spec.nodes
    .slice()
    .sort((left, right) => {
      const controlScore = (node: PatentDiagramNode) =>
        (/控制|调度|处理|管理|平台|主机|服务器/.test(node.label) ? 100 : 0)
        + (degree.get(node.id) || 0);
      return controlScore(right) - controlScore(left);
    })[0];
}

function layoutSystemBlock(spec: PatentDiagramSpec, width: number, height: number): DiagramLayout {
  const center = selectCentralNode(spec) || spec.nodes[0];
  const others = spec.nodes.filter((node) => node.id !== center?.id);
  const outgoing = new Set(
    spec.edges.filter((edge) => edge.from === center?.id).map((edge) => edge.to)
  );
  const incoming = new Set(
    spec.edges.filter((edge) => edge.to === center?.id).map((edge) => edge.from)
  );
  const middle = others.filter((node) => outgoing.has(node.id) || incoming.has(node.id));
  const bottom = others.filter((node) => !middle.some((item) => item.id === node.id));
  const rows: PatentDiagramNode[][] = [];
  if (center) rows.push([center]);
  if (middle.length) rows.push(middle);
  if (bottom.length) rows.push(bottom);
  if (!rows.length) rows.push(spec.nodes);

  const ranks = new Map<string, number>();
  const positioned: PositionedNode[] = [];
  const top = CANVAS_MARGIN + 24;
  const bottomPad = CANVAS_MARGIN + 40;
  const marginX = CANVAS_MARGIN;
  rows.forEach((items, rowIndex) => {
    const available = width - marginX * 2;
    const maxBoxWidth = Math.min(580, Math.floor(available / items.length - 36));
    const maxLabelPixels = Math.max(72, maxBoxWidth - REF_COLUMN_WIDTH - LABEL_PADDING_X);
    items.forEach((node, itemIndex) => {
      const lines = fitLabelLines(node.label, maxLabelPixels, 3);
      const box = nodeBoxSize(lines, 'vertical', { maxWidth: maxBoxWidth });
      const x = marginX + available * (itemIndex + 1) / (items.length + 1);
      const y = rows.length === 1
        ? height / 2
        : top + rowIndex * (height - top - bottomPad) / Math.max(rows.length - 1, 1);
      ranks.set(node.id, rowIndex);
      positioned.push({
        ...node,
        x: node.x ?? x,
        y: node.y ?? y,
        width: box.width,
        height: box.height,
        lines,
        shape: 'rect'
      });
    });
  });
  return {
    nodes: clampNodesToCanvas(positioned, width, height),
    ranks,
    orientation: 'vertical'
  };
}

function layoutRadial(spec: PatentDiagramSpec, width: number, height: number): DiagramLayout {
  return layoutSystemBlock(spec, width, height);
}

function buildLayout(spec: PatentDiagramSpec, width: number, height: number) {
  if (spec.kind === 'flowchart') return layoutLayered(spec, width, height, 'vertical');
  // structure/block 均用纵向分层，避免多列横向把框宽压到文字放不下
  if (spec.kind === 'structure') return layoutLayered(spec, width, height, 'vertical');
  return layoutLayered(spec, width, height, 'vertical');
}

function portOffset(index: number, count: number, available: number) {
  if (count <= 1) return 0;
  const span = Math.min(available, (count - 1) * 34);
  return -span / 2 + index * span / (count - 1);
}

function renderEdgeLabel(label: string, x: number, y: number, canvasWidth = DEFAULT_WIDTH, canvasHeight = DEFAULT_HEIGHT) {
  const maxLabelPixels = 240;
  const lines = fitLabelLines(label, maxLabelPixels, 2);
  const textWidthPx = Math.max(...lines.map((line) => measureTextPixels(line, 16)));
  const padX = 16;
  const boxWidth = Math.max(60, textWidthPx + padX * 2);
  const boxHeight = lines.length * 20 + 14;
  const clampedX = Math.min(Math.max(x, boxWidth / 2 + CANVAS_MARGIN), canvasWidth - boxWidth / 2 - CANVAS_MARGIN);
  const clampedY = Math.min(Math.max(y, boxHeight / 2 + CANVAS_MARGIN), canvasHeight - boxHeight / 2 - 48);
  const textX = clampedX - boxWidth / 2 + padX;
  const startY = clampedY - (lines.length - 1) * 10 + 5;
  return [
    `<rect x="${(clampedX - boxWidth / 2).toFixed(1)}" y="${(clampedY - boxHeight / 2).toFixed(1)}" width="${boxWidth.toFixed(1)}" height="${boxHeight}" rx="0" fill="#fff" stroke="#000" stroke-width="1"/>`,
    `<text x="${textX.toFixed(1)}" y="${startY.toFixed(1)}" text-anchor="start" font-size="16" font-family="${FONT_FAMILY}">`,
    ...lines.map((line, index) =>
      `<tspan x="${textX.toFixed(1)}" dy="${index === 0 ? 0 : 20}">${escapeXml(line)}</tspan>`
    ),
    '</text>'
  ].join('');
}

function renderLayeredEdges(spec: PatentDiagramSpec, layout: DiagramLayout) {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const outgoing = new Map(layout.nodes.map((node) => [
    node.id,
    spec.edges.filter((edge) => edge.from === node.id)
  ]));
  const incoming = new Map(layout.nodes.map((node) => [
    node.id,
    spec.edges.filter((edge) => edge.to === node.id)
  ]));
  const paths: string[] = [];
  const labels: string[] = [];
  const minX = Math.min(...layout.nodes.map((node) => node.x - node.width / 2));
  const maxX = Math.max(...layout.nodes.map((node) => node.x + node.width / 2));
  const minY = Math.min(...layout.nodes.map((node) => node.y - node.height / 2));
  const maxY = Math.max(...layout.nodes.map((node) => node.y + node.height / 2));

  spec.edges.forEach((edge, edgeIndex) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;
    const fromEdges = outgoing.get(from.id) || [];
    const toEdges = incoming.get(to.id) || [];
    const fromIndex = Math.max(0, fromEdges.indexOf(edge));
    const toIndex = Math.max(0, toEdges.indexOf(edge));
    const rankGap = (layout.ranks.get(to.id) || 0) - (layout.ranks.get(from.id) || 0);
    const forward = rankGap > 0;

    if (layout.orientation === 'vertical' && rankGap === 1) {
      const x1 = from.x + portOffset(fromIndex, fromEdges.length, from.width - 130);
      const y1 = from.y + from.height / 2;
      const x2 = to.x + portOffset(toIndex, toEdges.length, to.width - 130);
      const y2 = to.y - to.height / 2;
      const midY = (y1 + y2) / 2 + (edgeIndex % 2 ? 5 : -5);
      paths.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} V ${midY.toFixed(1)} H ${x2.toFixed(1)} V ${y2.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
      if (edge.label) {
        const labelX = Math.abs(x2 - x1) < 24 ? x1 + 62 : (x1 + x2) / 2;
        labels.push(renderEdgeLabel(edge.label, labelX, midY - 13));
      }
      return;
    }

    if (layout.orientation === 'horizontal' && rankGap === 1) {
      const x1 = from.x + from.width / 2;
      const y1 = from.y + portOffset(fromIndex, fromEdges.length, from.height - 32);
      const x2 = to.x - to.width / 2;
      const y2 = to.y + portOffset(toIndex, toEdges.length, to.height - 32);
      const midX = (x1 + x2) / 2 + (edgeIndex % 2 ? 5 : -5);
      paths.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} H ${midX.toFixed(1)} V ${y2.toFixed(1)} H ${x2.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
      if (edge.label) {
        const labelY = Math.abs(y2 - y1) < 24 ? y1 - 25 : (y1 + y2) / 2;
        labels.push(renderEdgeLabel(edge.label, midX, labelY));
      }
      return;
    }

    if (layout.orientation === 'vertical' && forward) {
      const x1 = from.x + from.width / 2;
      const y1 = from.y;
      const x2 = to.x + to.width / 2;
      const y2 = to.y;
      const outerX = edgeIndex % 2 === 0 ? maxX + 48 : minX - 48;
      paths.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} H ${outerX.toFixed(1)} V ${y2.toFixed(1)} H ${x2.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
      if (edge.label) labels.push(renderEdgeLabel(edge.label, outerX, (y1 + y2) / 2));
      return;
    }

    if (layout.orientation === 'horizontal' && forward) {
      const x1 = from.x + from.width / 2;
      const y1 = from.y;
      const x2 = to.x - to.width / 2;
      const y2 = to.y;
      const useTopLane = from.y <= (minY + maxY) / 2;
      const outerY = useTopLane ? minY - 58 : maxY + 58;
      paths.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} H ${(x1 + 28).toFixed(1)} V ${outerY.toFixed(1)} H ${(x2 - 28).toFixed(1)} V ${y2.toFixed(1)} H ${x2.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
      if (edge.label) labels.push(renderEdgeLabel(edge.label, (x1 + x2) / 2, outerY));
      return;
    }

    const lane = 38 + edgeIndex * 13;
    if (layout.orientation === 'vertical') {
      const side = Math.max(from.x + from.width / 2, to.x + to.width / 2) + lane;
      paths.push(`<path d="M ${(from.x + from.width / 2).toFixed(1)} ${from.y.toFixed(1)} H ${side.toFixed(1)} V ${to.y.toFixed(1)} H ${(to.x + to.width / 2).toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
      if (edge.label) labels.push(renderEdgeLabel(edge.label, side, (from.y + to.y) / 2));
    } else {
      const side = Math.max(from.y + from.height / 2, to.y + to.height / 2) + lane;
      paths.push(`<path d="M ${from.x.toFixed(1)} ${(from.y + from.height / 2).toFixed(1)} V ${side.toFixed(1)} H ${to.x.toFixed(1)} V ${(to.y + to.height / 2).toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
      if (edge.label) labels.push(renderEdgeLabel(edge.label, (from.x + to.x) / 2, side));
    }
  });
  return { paths, labels };
}

function rectangleBoundaryPoint(from: PositionedNode, to: PositionedNode) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const scale = 1 / Math.max(
    Math.abs(dx) / Math.max(from.width / 2, 1),
    Math.abs(dy) / Math.max(from.height / 2, 1)
  );
  return {
    x: from.x + dx * scale,
    y: from.y + dy * scale
  };
}

function offsetBoundaryPort(
  point: { x: number; y: number },
  node: PositionedNode,
  index: number,
  count: number
) {
  if (count <= 1) return point;
  const horizontalSide = Math.abs(point.y - node.y) / Math.max(node.height / 2, 1)
    >= Math.abs(point.x - node.x) / Math.max(node.width / 2, 1);
  const offset = portOffset(index, count, horizontalSide ? node.width - 130 : node.height - 30);
  return horizontalSide
    ? { x: point.x + offset, y: point.y }
    : { x: point.x, y: point.y + offset };
}

function renderRadialEdges(spec: PatentDiagramSpec, layout: DiagramLayout) {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const center = layout.nodes.find((node) => (layout.ranks.get(node.id) || 0) === 0);
  const outgoing = new Map(layout.nodes.map((node) => [
    node.id,
    spec.edges.filter((edge) => edge.from === node.id)
  ]));
  const incoming = new Map(layout.nodes.map((node) => [
    node.id,
    spec.edges.filter((edge) => edge.to === node.id)
  ]));
  const paths: string[] = [];
  const labels: string[] = [];
  const edgePairs = new Set(spec.edges.map((edge) => `${edge.from}->${edge.to}`));

  spec.edges.forEach((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to || from.id === to.id) return;
    const fromEdges = outgoing.get(from.id) || [];
    const toEdges = incoming.get(to.id) || [];
    const start = offsetBoundaryPort(
      rectangleBoundaryPoint(from, to),
      from,
      Math.max(0, fromEdges.indexOf(edge)),
      fromEdges.length
    );
    const end = offsetBoundaryPort(
      rectangleBoundaryPoint(to, from),
      to,
      Math.max(0, toEdges.indexOf(edge)),
      toEdges.length
    );
    const reciprocal = edgePairs.has(`${edge.to}->${edge.from}`);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(Math.hypot(dx, dy), 1);
    const bothPeripheral = center && from.id !== center.id && to.id !== center.id;
    if (bothPeripheral) {
      const fromCenterX = from.x - center.x;
      const fromCenterY = from.y - center.y;
      const toCenterX = to.x - center.x;
      const toCenterY = to.y - center.y;
      const directionSimilarity = (
        fromCenterX * toCenterX + fromCenterY * toCenterY
      ) / Math.max(
        Math.hypot(fromCenterX, fromCenterY) * Math.hypot(toCenterX, toCenterY),
        1
      );
      if (!reciprocal && directionSimilarity < -0.65) {
        if (Math.abs(from.y - to.y) >= Math.abs(from.x - to.x)) {
          const laneX = center.x - center.width / 2 - 90;
          const approachY = end.y + (from.y > to.y ? 28 : -28);
          paths.push(`<path d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} H ${laneX.toFixed(1)} V ${approachY.toFixed(1)} H ${end.x.toFixed(1)} V ${end.y.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
          if (edge.label) {
            const labelY = from.y > to.y ? start.y - 78 : start.y + 78;
            labels.push(renderEdgeLabel(edge.label, laneX, labelY));
          }
        } else {
          const laneY = center.y - center.height / 2 - 90;
          const approachX = end.x + (from.x > to.x ? 28 : -28);
          paths.push(`<path d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} V ${laneY.toFixed(1)} H ${approachX.toFixed(1)} V ${end.y.toFixed(1)} H ${end.x.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`);
          if (edge.label) {
            const labelX = from.x > to.x ? start.x - 92 : start.x + 92;
            labels.push(renderEdgeLabel(edge.label, labelX, laneY));
          }
        }
        return;
      }
    }
    const baseMidX = (start.x + end.x) / 2;
    const baseMidY = (start.y + end.y) / 2;
    let midX = baseMidX;
    let midY = baseMidY;
    let curved = reciprocal;
    if (reciprocal) {
      const reciprocalOffset = center && (from.id === center.id || to.id === center.id) ? 108 : 72;
      midX -= dy / length * reciprocalOffset;
      midY += dx / length * reciprocalOffset;
    } else if (bothPeripheral) {
      curved = true;
      const outwardX = baseMidX - center.x;
      const outwardY = baseMidY - center.y;
      const outwardLength = Math.hypot(outwardX, outwardY);
      if (outwardLength < 30) {
        midX += -dy / length * 500;
        midY += dx / length * 500;
      } else {
        midX += outwardX / outwardLength * 180;
        midY += outwardY / outwardLength * 180;
      }
    }
    paths.push(curved
      ? `<path d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`
      : `<path d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}" class="edge" marker-end="url(#arrow)"/>`
    );
    if (edge.label) {
      const labelOffset = reciprocal && center && (from.id === center.id || to.id === center.id)
        ? 42
        : reciprocal
          ? 28
          : 14;
      const labelX = (start.x + 2 * midX + end.x) / 4 - dy / length * labelOffset;
      const labelY = (start.y + 2 * midY + end.y) / 4 + dx / length * labelOffset;
      labels.push(renderEdgeLabel(edge.label, labelX, labelY));
    }
  });
  return { paths, labels };
}

function renderNode(node: PositionedNode) {
  const x = node.x - node.width / 2;
  const y = node.y - node.height / 2;
  const refWidth = node.ref ? REF_COLUMN_WIDTH : 0;
  // 左对齐：避免 librsvg 对 CJK middle 锚点测宽偏小导致文字右偏溢出
  const textX = x + refWidth + LABEL_PADDING_X / 2;
  const firstLineY = node.y - (node.lines.length - 1) * LINE_HEIGHT / 2 + 8;
  const radius = node.shape === 'stadium' ? node.height / 2 : 0;
  return [
    `<g class="node" data-node-id="${escapeXml(node.id)}">`,
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${node.width.toFixed(1)}" height="${node.height}" rx="${radius.toFixed(1)}" fill="#fff" stroke="#000" stroke-width="${NODE_STROKE}"/>`,
    node.ref
      ? `<line x1="${(x + refWidth).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + refWidth).toFixed(1)}" y2="${(y + node.height).toFixed(1)}" stroke="#000" stroke-width="1.6"/>`
      : '',
    node.ref
      ? `<text x="${(x + refWidth / 2).toFixed(1)}" y="${(node.y + 7).toFixed(1)}" text-anchor="middle" font-size="${REF_FONT_SIZE}" font-family="${REF_FONT_FAMILY}">${escapeXml(node.ref)}</text>`
      : '',
    `<text x="${textX.toFixed(1)}" y="${firstLineY.toFixed(1)}" text-anchor="start" font-size="${LABEL_FONT_SIZE}" font-family="${FONT_FAMILY}">`,
    ...node.lines.map((line, index) =>
      `<tspan x="${textX.toFixed(1)}" dy="${index === 0 ? 0 : LINE_HEIGHT}">${escapeXml(line)}</tspan>`
    ),
    '</text>',
    '</g>'
  ].filter(Boolean).join('');
}

export function renderDiagramSvg(
  spec: PatentDiagramSpec,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  outputScale = 1
) {
  const layout = buildLayout(spec, width, height);
  const renderedEdges = layout.orientation === 'radial'
    ? renderRadialEdges(spec, layout)
    : renderLayeredEdges(spec, layout);
  const pixelWidth = Math.round(width * outputScale);
  const pixelHeight = Math.round(height * outputScale);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    `<defs><style type="text/css"><![CDATA[${EMBEDDED_FONT_CSS}]]></style>`,
    '<marker id="arrow" markerWidth="10" markerHeight="10" refX="8.5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8.5,3.5 L0,7 Z" fill="#000"/></marker>',
    '</defs>',
    '<style>.edge{fill:none;stroke:#000;stroke-width:2;stroke-linejoin:miter;stroke-linecap:butt}</style>',
    ...renderedEdges.paths,
    ...renderedEdges.labels,
    ...layout.nodes.map(renderNode),
    `<text x="${width / 2}" y="${height - 28}" text-anchor="middle" font-size="26" font-family="${FONT_FAMILY}">图${spec.figureNumber}</text>`,
    '</svg>'
  ].join('');
}

export async function renderDiagramPng(
  spec: PatentDiagramSpec,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT
) {
  const svg = renderDiagramSvg(spec, width, height, OUTPUT_SCALE);
  return sharp(Buffer.from(svg, 'utf8'), { density: 72 })
    .flatten({ background: '#ffffff' })
    .png({
      compressionLevel: 6,
      adaptiveFiltering: true,
      palette: false
    })
    .toBuffer();
}

export async function inspectRenderedDiagram(
  spec: PatentDiagramSpec,
  png: Buffer,
  svg = renderDiagramSvg(spec)
): Promise<DiagramInspection> {
  const issues: string[] = [];
  const image = sharp(png).removeAlpha();
  const metadata = await image.metadata();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  let inkPixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset] < 235 || data[offset + 1] < 235 || data[offset + 2] < 235) inkPixels += 1;
  }
  const inkRatio = inkPixels / Math.max(info.width * info.height, 1);
  const layout = buildLayout(spec, DEFAULT_WIDTH, DEFAULT_HEIGHT);
  const scaleX = info.width / DEFAULT_WIDTH;
  const scaleY = info.height / DEFAULT_HEIGHT;
  let labelledNodes = 0;
  for (const node of layout.nodes) {
    const refWidth = node.ref ? 64 : 0;
    const left = Math.max(0, Math.round((node.x - node.width / 2 + refWidth + 8) * scaleX));
    const right = Math.min(info.width - 1, Math.round((node.x + node.width / 2 - 8) * scaleX));
    const top = Math.max(0, Math.round((node.y - node.height / 2 + 8) * scaleY));
    const bottom = Math.min(info.height - 1, Math.round((node.y + node.height / 2 - 8) * scaleY));
    let dark = 0;
    for (let y = top; y <= bottom; y += Math.max(1, Math.floor(scaleY))) {
      for (let x = left; x <= right; x += Math.max(1, Math.floor(scaleX))) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset] < 180 || data[offset + 1] < 180 || data[offset + 2] < 180) dark += 1;
      }
    }
    if (dark >= 20) labelledNodes += 1;
  }

  const svgTextContent = svg.replace(/<[^>]+>/g, '');
  for (const node of spec.nodes) {
    if (!normalizeLabel(node.label)) issues.push(`节点 ${node.id} 缺少文字标签`);
    if (!svgTextContent.includes(escapeXml(normalizeLabel(node.label)))) {
      issues.push(`SVG 未完整包含节点 ${node.id} 的文字标签`);
    }
  }
  if ((metadata.width || 0) < 1800 || (metadata.height || 0) < 1200) {
    issues.push(`分辨率不足：${metadata.width || 0}×${metadata.height || 0}`);
  }
  if (png.length < 30_000) issues.push(`PNG 内容过少：${png.length} bytes`);
  if (inkRatio < 0.004) issues.push(`图面信息密度过低：${(inkRatio * 100).toFixed(2)}%`);
  if (inkRatio > 0.28) issues.push(`图面信息过密：${(inkRatio * 100).toFixed(2)}%`);
  if (labelledNodes !== spec.nodes.length) {
    issues.push(`仅 ${labelledNodes}/${spec.nodes.length} 个节点检测到可见文字`);
  }
  for (const node of layout.nodes) {
    const labelArea = node.width - (node.ref ? REF_COLUMN_WIDTH : 0) - LABEL_PADDING_X;
    const overflowLines = node.lines.filter((line) => measureTextPixels(line) > labelArea + 1);
    if (overflowLines.length) {
      issues.push(`节点 ${node.id} 文字超出框内宽度：${overflowLines.join('/')}`);
    }
    if (
      node.x - node.width / 2 < CANVAS_MARGIN / 2
      || node.x + node.width / 2 > DEFAULT_WIDTH - CANVAS_MARGIN / 2
      || node.y - node.height / 2 < CANVAS_MARGIN / 2
      || node.y + node.height / 2 > DEFAULT_HEIGHT - 36
    ) {
      issues.push(`节点 ${node.id} 超出画布边界`);
    }
  }
  if (spec.nodes.length < 3) issues.push('节点数量不足，不能表达完整技术关系');
  if (spec.edges.length < Math.max(2, spec.nodes.length - 2)) {
    issues.push('节点连线不足，技术关系表达不完整');
  }

  return {
    passed: issues.length === 0,
    issues,
    width: metadata.width || 0,
    height: metadata.height || 0,
    pngBytes: png.length,
    inkRatio,
    labelledNodes,
    totalNodes: spec.nodes.length
  };
}
