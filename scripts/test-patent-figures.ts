import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildFallbackDiagramSpecs,
  encodePngRgb,
  inspectRenderedDiagram,
  persistGeneratedDiagrams,
  renderDiagramPng,
  renderDiagramSvg
} from '../src/lib/patent-generation/figures';
import type { InventionDisclosure } from '../src/lib/patent-generation/types';

async function main() {
  const rgb = Buffer.alloc(8 * 8 * 3, 255);
  const tiny = encodePngRgb(8, 8, rgb);
  assert.equal(tiny[0], 0x89);
  assert.equal(tiny.toString('ascii', 1, 4), 'PNG');

  const disclosure: InventionDisclosure = {
    proposedTitle: '一种测试优化调度方法',
    technicalField: '电力系统',
    background: '现有技术缺少协同',
    technicalProblems: ['负荷波动'],
    inventiveConcept: '时空协同优化',
    essentialFeatures: [
      { id: 'EF1', name: '负荷预测', description: '', essential: true, technicalEffect: '', anchors: [] },
      { id: 'EF2', name: '约束建模', description: '', essential: true, technicalEffect: '', anchors: [] },
      { id: 'EF3', name: '优化求解', description: '', essential: true, technicalEffect: '', anchors: [] }
    ],
    optionalFeatures: [],
    inputs: [],
    outputs: [],
    constraints: [],
    technicalEffects: [],
    embodiments: ['实施例一'],
    figureSuggestions: ['图1 方法流程示意图', '图2 系统结构示意图'],
    sourceAnchors: [],
    assumptions: [],
    missingInformation: []
  };
  const specs = buildFallbackDiagramSpecs(disclosure);
  assert.ok(specs.length >= 2);
  const png = await renderDiagramPng(specs[0]);
  const svg = renderDiagramSvg(specs[0]);
  const inspection = await inspectRenderedDiagram(specs[0], png, svg);
  assert.ok(inspection.passed, inspection.issues.join('；'));
  assert.ok(svg.includes('<svg'));
  for (const node of specs[0].nodes) {
    assert.ok(svg.includes(node.label), `SVG 缺少节点标签：${node.label}`);
  }
  const dir = path.join(process.cwd(), 'storage', 'patents', '_figure-smoke');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const assets = await persistGeneratedDiagrams({ projectDir: dir, specs });
  assert.equal(assets.length, specs.length);
  for (const asset of assets) {
    await fs.access(path.join(dir, asset.relativePath));
  }
  console.log(JSON.stringify({
    ok: true,
    specs: specs.length,
    pngBytes: png.length,
    inkRatio: inspection.inkRatio,
    labelledNodes: inspection.labelledNodes,
    assets: assets.map((asset) => asset.fileName)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
