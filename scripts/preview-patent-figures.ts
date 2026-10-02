import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inspectRenderedDiagram,
  renderDiagramPng,
  renderDiagramSvg
} from '../src/lib/patent-generation/diagram-renderer';
import type { PatentDiagramSpec } from '../src/lib/patent-generation/types';

const specs: PatentDiagramSpec[] = [
  {
    figureNumber: 1,
    title: '图1 方法流程图',
    kind: 'flowchart',
    nodes: [
      { id: 'N1', label: '开始', ref: '101' },
      { id: 'N2', label: '构建算力负载时空特性模型', ref: '102' },
      { id: 'N3', label: '构建室内等效热容热力学模型', ref: '103' },
      { id: 'N4', label: '构建协同优化目标函数', ref: '104' },
      { id: 'N5', label: '建立多物理场耦合约束', ref: '105' },
      { id: 'N6', label: '求解并输出调度结果', ref: '106' },
      { id: 'N7', label: '结束', ref: '107' }
    ],
    edges: [
      { from: 'N1', to: 'N2' },
      { from: 'N2', to: 'N3' },
      { from: 'N3', to: 'N4' },
      { from: 'N4', to: 'N5' },
      { from: 'N5', to: 'N6' },
      { from: 'N6', to: 'N7' }
    ]
  },
  {
    figureNumber: 2,
    title: '图2 系统结构图',
    kind: 'block',
    nodes: [
      { id: 'S1', label: '调度控制中心', ref: '201' },
      { id: 'S2', label: '算力建模模块', ref: '202' },
      { id: 'S3', label: '热力建模模块', ref: '203' },
      { id: 'S4', label: '目标构建模块', ref: '204' },
      { id: 'S5', label: '约束求解模块', ref: '205' },
      { id: 'S6', label: '结果输出模块', ref: '206' }
    ],
    edges: [
      { from: 'S1', to: 'S2' },
      { from: 'S1', to: 'S3' },
      { from: 'S1', to: 'S4' },
      { from: 'S2', to: 'S5' },
      { from: 'S3', to: 'S5' },
      { from: 'S4', to: 'S5' },
      { from: 'S5', to: 'S6' }
    ]
  },
  {
    figureNumber: 3,
    title: '图3 数据流图',
    kind: 'structure',
    nodes: [
      { id: 'E1', label: '负荷与电价数据', ref: '301' },
      { id: 'E2', label: '时空特征提取', ref: '302' },
      { id: 'E3', label: '协同优化求解', ref: '303' },
      { id: 'E4', label: '调度指令输出', ref: '304' }
    ],
    edges: [
      { from: 'E1', to: 'E2' },
      { from: 'E2', to: 'E3' },
      { from: 'E3', to: 'E4' }
    ]
  }
];

async function main() {
  const outDir = path.join('storage', 'patents', '_figure-quality', 'figures');
  await fs.mkdir(outDir, { recursive: true });
  for (const spec of specs) {
    const svg = renderDiagramSvg(spec);
    const png = await renderDiagramPng(spec);
    const inspection = await inspectRenderedDiagram(spec, png, svg);
    const base = `fig${spec.figureNumber}`;
    await fs.writeFile(path.join(outDir, `${base}.svg`), svg);
    await fs.writeFile(path.join(outDir, `${base}.png`), png);
    console.log(JSON.stringify({
      figure: spec.figureNumber,
      bytes: png.length,
      width: inspection.width,
      height: inspection.height,
      inkRatio: Number(inspection.inkRatio.toFixed(4)),
      labelledNodes: inspection.labelledNodes,
      passed: inspection.passed,
      issues: inspection.issues
    }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
