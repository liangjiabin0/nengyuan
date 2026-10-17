import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { buildPatentExportBundle } from '../src/lib/patent-generation/export';
import { runPatentPipeline } from '../src/lib/patent-generation/pipeline';
import { parsePatentSource } from '../src/lib/patent-generation/source-parser';
import {
  createPatentProject,
  getPatentProject,
  updatePatentProject
} from '../src/lib/patent-generation/store';
import { countAbstractCharacters, splitClaims } from '../src/lib/patent-generation/validators';

const disclosure = `# 一种具有自清洁采样通道的空气花粉采集装置

## 技术领域
本方案涉及空气颗粒物采样设备，尤其涉及一种用于野外连续监测的花粉采集装置。

## 背景与问题
现有旋转式花粉采集器在高湿度环境连续工作时，花粉和灰尘容易附着在采样入口及滤网上。堵塞会改变采样流量，人工拆洗期间还会造成监测数据中断。需要在不引入清洗液、不中断主采样过程的情况下清理入口沉积物，并能够确认清洁动作是否有效。

## 技术方案
装置包括壳体、主采样通道、旁通通道、可拆卸滤网、风机、差压传感器、两位三通切换阀、弹性刮片、偏心驱动轮、集尘盒和控制器。
主采样通道的入口与壳体外部连通，滤网横向安装在主采样通道内。差压传感器的两个取压口分别位于滤网上游和下游。旁通通道的两端分别连接主采样通道入口和风机入口，两位三通切换阀选择性地使风机连接主采样通道或旁通通道。
弹性刮片贴靠滤网的上游表面，偏心驱动轮转动时带动弹性刮片沿滤网表面往复移动。滤网下缘设置朝向集尘盒的导尘斜面，刮落颗粒在重力和旁通气流作用下进入可抽出的集尘盒。

控制器以固定采样周期读取差压值和风机转速。当连续三个采样周期的差压值均高于堵塞阈值时，控制器保持风机运行，控制两位三通切换阀切换至旁通通道，使主采样通道的流量暂时降低；随后驱动偏心驱动轮转动两个完整周期，使弹性刮片往复清扫滤网；清扫结束后切换阀恢复主采样通道。控制器比较清扫前后的差压值，当差压下降比例未达到恢复阈值时重复一次清扫；第二次仍未恢复时输出维护提示。

## 技术效果与实施信息
旁通通道使清扫期间风机无需停机，并维持壳体内部的定向气流，减少外部颗粒倒灌。差压闭环避免仅按固定时间清扫造成无效磨损。刮片、导尘斜面和集尘盒形成明确的颗粒转移路径。
堵塞阈值、恢复阈值、采样周期和风机转速根据滤网面积与目标采样流量标定，不作为独立权利要求中的固定数值。壳体、通道和集尘盒可采用耐候工程塑料；刮片可采用硅橡胶。装置可由太阳能电池与蓄电池供电。

## 附图建议
图1示出装置总体结构以及主采样通道和旁通通道的连接关系。
图2示出差压触发、旁通切换、往复清扫、恢复判断和维护提示的控制流程。
`;

async function main() {
  const buffer = Buffer.from(disclosure, 'utf8');
  const parsed = await parsePatentSource('花粉采集装置技术交底.md', buffer);
  let project = process.env.PATENT_REAL_PROJECT_ID
    ? getPatentProject(process.env.PATENT_REAL_PROJECT_ID)
    : await createPatentProject({
        name: '花粉采集装置技术交底.md',
        mediaType: 'text/markdown',
        buffer,
        parsed
      });
  assert.ok(project);
  console.log(`project=${project!.id}`);

  for (let pass = 0; pass < 3 && project!.status !== 'completed'; pass += 1) {
    project = await runPatentPipeline(project!.id, (event) => {
      if (event.type === 'status') {
        console.log(`${event.progress}% [${event.stage}] ${event.detail}`);
      }
    });
    if (project.status === 'needs_input') {
      const answers: Record<string, string> = {};
      let applicant: string | undefined;
      let inventors: string[] | undefined;
      for (const blocker of project.blockers.filter((item) => !item.resolved)) {
        if (blocker.id === 'confirm-applicant') applicant = '端到端测试申请人（非提交信息）';
        else if (blocker.id === 'confirm-inventors') inventors = ['端到端测试发明人'];
        else answers[blocker.id] = '以上述技术交底明确记载的结构、连接关系和控制步骤为边界，不补充无来源实验数据。';
      }
      project = updatePatentProject(project.id, { applicant, inventors, answers });
    }
  }

  project = getPatentProject(project!.id);
  assert.ok(project?.draft);
  assert.ok(project?.audit);
  assert.ok(['completed', 'review_required'].includes(project!.status), `status=${project!.status}`);
  assert.ok(splitClaims(project!.draft!.claims).length >= 5);
  assert.ok(countAbstractCharacters(project!.draft!.abstract) <= 300);
  assert.doesNotMatch(JSON.stringify(project!.draft), /数据中心|算力负载|热阻-热容|排队冗余/);

  const output = await buildPatentExportBundle(project!);
  const archive = await JSZip.loadAsync(output.buffer);
  const docxName = Object.keys(archive.files).find((name) => name.endsWith('.docx'));
  assert.ok(docxName);
  const docx = await JSZip.loadAsync(await archive.file(docxName!)!.async('nodebuffer'));
  assert.ok(docx.file('word/document.xml'));

  const outputDir = path.join(process.cwd(), 'outputs', 'patent-real-e2e');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, output.fileName), output.buffer);
  console.log(JSON.stringify({
    projectId: project!.id,
    status: project!.status,
    score: project!.audit!.score,
    rounds: project!.audit!.rounds,
    claims: splitClaims(project!.draft!.claims).length,
    drawings: project!.drawings?.assets.length || 0,
    output: path.join(outputDir, output.fileName)
  }, null, 2));
  console.log('PATENT_REAL_E2E=PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
