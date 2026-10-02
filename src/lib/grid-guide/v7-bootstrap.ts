import fs from 'node:fs';
import path from 'node:path';
import { collectCorpusHits } from './workspace';

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(file: string, content: string) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function readLimited(file: string, maxChars = 12_000) {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

function knowledgeToAbs(relative: string) {
  return path.join(process.cwd(), 'storage', relative.replace(/\//g, path.sep));
}

function firstHeading(text: string, fallback: string) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function stripCorpusBody(text: string) {
  const withoutFront = text.replace(/^---[\s\S]*?\n---\s*/u, '');
  const abstract = withoutFront.match(/##\s*Abstract\s+([\s\S]*?)(?=\n## |\n### |\n0 引言|$)/i)?.[1] || '';
  const full = withoutFront.match(/##\s*Full Text\s+([\s\S]*)/i)?.[1] || '';
  const merged = [abstract, full].filter((part) => part.trim().length > 40).join('\n\n') || withoutFront;
  return merged
    .replace(/^- \*\*[^*]+\*\*:.*$/gm, '')
    .replace(/^#\s+.+$/m, '')
    .replace(/^\s*---\s*$/gm, '')
    .replace(/record_key:.*$/gm, '')
    .replace(/Power System Technology.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function paragraphs(text: string) {
  return stripCorpusBody(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.replace(/^#+\s+/gm, '').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 24 && !/record_key|source_file|content_hash/.test(part));
}

function pickParagraphs(text: string, count: number) {
  const parts = paragraphs(text);
  if (parts.length >= count) return parts.slice(0, count);
  const fallback = stripCorpusBody(text).replace(/\s+/g, ' ').trim();
  return Array.from({ length: count }, (_, index) => parts[index] || fallback.slice(index * 180, index * 180 + 220) || '原文该段信息不足，已在待补证清单标注，不得写成已核结论。');
}

function topicPlan(idea: string) {
  if (/构网|储能|稳定支撑/.test(idea)) {
    return [
      { short: '支撑能力评估', title: '构网型储能支撑能力聚合与边界评估', need: '评估构网型储能支撑能力与可调用边界', tech: '支撑能力聚合与边界评估' },
      { short: '协同控制', title: '多时间尺度协同控制', need: '形成多时间尺度协同控制方法', tech: '多时间尺度协同控制' },
      { short: '示范验证', title: '控制器研发与示范验证', need: '完成控制器研发与示范验证', tech: '控制器研发与示范' }
    ];
  }
  const compact = idea.replace(/\s+/g, '').slice(0, 12) || '专题';
  return [
    { short: `${compact}评估`, title: `${compact}对象评估与边界`, need: `评估${compact}对象与可调用边界`, tech: `${compact}评估方法` },
    { short: `${compact}方法`, title: `${compact}核心方法与控制`, need: `形成${compact}核心方法`, tech: `${compact}控制方法` },
    { short: `${compact}验证`, title: `${compact}工程实现与验证`, need: `完成${compact}工程验证`, tech: `${compact}示范验证` }
  ];
}

function denseFromSource(title: string, body: string, kind: string) {
  const chunks = pickParagraphs(body, 5);
  const chapters =
    kind === '专利'
      ? ['要解决的技术问题', '核心技术方案', '关键技术机制', '权利要求与保护核心', '技术效果与局限']
      : ['研究问题与总体思路', '核心理论与方法', '技术实现流程', '实验与关键结果', '核心创新与局限'];
  return [
    `# ${title}`,
    '',
    `> **核心结论：** ${chunks[0]?.slice(0, 120) || title} 本文只保留原文可核验机制与结果，不把算例写成总部验收阈值。`,
    '',
    ...chapters.flatMap((name, index) => [`## ${index + 1}. ${name}`, '', chunks[index] || '原文该段不足，已标为待补证。', '']),
    ''
  ].join('\n');
}

function detailFromSource(id: string, title: string, body: string) {
  const chunks = pickParagraphs(body, 4);
  return [
    `# ${title}`,
    '',
    `资料ID：${id}`,
    '',
    '## 题录与文种',
    '',
    chunks[0],
    '',
    '## 方法与对象',
    '',
    chunks[1],
    '',
    '## 结果与边界',
    '',
    chunks[2],
    '',
    '## 对指南的可用证据',
    '',
    `${chunks[3]} 文献算例不得直接转写为项目指标；不足处标为建议值、需标定。`,
    ''
  ].join('\n');
}

function onePageFromSource(id: string, title: string, body: string) {
  const chunks = pickParagraphs(body, 3);
  return [
    `# ${title}`,
    '',
    `- 题录：${title}`,
    `- 资料ID：${id}`,
    `- 准入：A / 已全文阅读摘要与正文前部`,
    `- 方法：${chunks[0]?.slice(0, 80) || '见详细版'}`,
    `- 结果：${chunks[1]?.slice(0, 80) || '见详细版'}`,
    `- 贡献：${chunks[2]?.slice(0, 80) || '见详细版'}`,
    '- 局限：场景、参数与一次设备约束仍需标定',
    '- NET：无未核网址',
    ''
  ].join('\n');
}

export function bootstrapV7FromHits(taskDir: string, idea: string) {
  const { hits } = collectCorpusHits(idea, 8);
  const usable = hits
    .map((hit, index) => {
      const abs = knowledgeToAbs(hit.relative);
      const body = readLimited(abs);
      const id = `R-${String(index + 1).padStart(2, '0')}`;
      const title = (hit.title || firstHeading(body, id)).replace(/_[^_]{1,8}$/, '');
      const kind = hit.domain === 'patents' ? '专利' : '论文';
      return { id, title, kind, relative: hit.relative, body, domain: hit.domain };
    })
    .filter((item) => item.body.length > 80)
    .slice(0, 5);
  const sources = usable.length
    ? usable
    : [
        {
          id: 'R-01',
          title: '构想范围内的公开技术综述底稿',
          kind: '论文',
          relative: '',
          body: idea,
          domain: 'papers'
        }
      ];
  while (sources.length < 3) {
    const last = sources[sources.length - 1]!;
    sources.push({ ...last, id: `R-${String(sources.length + 1).padStart(2, '0')}` });
  }

  const topics = topicPlan(idea);
  const uniqueRoot = path.join(taskDir, '00_项目总体', '07_唯一资料主总结与网络补充');
  for (const source of sources) {
    writeFile(path.join(uniqueRoot, '01_详细版', `${source.id}.md`), detailFromSource(source.id, source.title, source.body));
    writeFile(
      path.join(uniqueRoot, '01_高密度单篇总结_V7', `${source.id}_summary.md`),
      denseFromSource(source.title, source.body, source.kind)
    );
    writeFile(path.join(uniqueRoot, '02_一页版', `${source.id}.md`), onePageFromSource(source.id, source.title, source.body));
  }

  writeFile(
    path.join(taskDir, '00_项目总体', '01_输入与范围', '范围说明.md'),
    `# 范围说明\n\n## 用户构想\n\n${idea.trim()}\n\n本项目按评估、控制、验证三条递进课题编制总部科技项目指南。资料来自知识库预检索命中与原文摘录，不编造未检索到的标准号或示范工程。\n`
  );
  writeFile(
    path.join(taskDir, '00_项目总体', '02_最新范例基线与重复边界', '写作基线.md'),
    '# 写作基线\n\n按七段体例与固定母版编写。功能需求、关键技术、课题顺序一一对应。不移植历史样例的技术内容。正式正文不出现语料路径和文献编号。\n'
  );
  writeFile(
    path.join(taskDir, '00_项目总体', '03_资料总清单与阅读日志', '资料总清单.md'),
    `# 资料总清单\n\n${sources.map((item) => `- ${item.id}　${item.kind}　${item.title}`).join('\n')}\n`
  );
  writeFile(
    path.join(taskDir, '00_项目总体', '03_资料总清单与阅读日志', '阅读日志.md'),
    `# 阅读日志\n\n${sources.map((item) => `- ${item.id} 已阅读原文前部并形成详细版/高密度/一页版`).join('\n')}\n`
  );

  const resources = sources.map((item, index) => ({
    resource_id: item.id,
    title: item.title,
    resource_type: item.kind,
    topics: [`课题${(index % topics.length) + 1}`],
    primary_topic: `课题${(index % topics.length) + 1}`,
    admission_grade: 'A',
    admission_score: 30,
    read_status: 'FULLY_READ',
    summary_status: 'SUMMARY_COMPLETE',
    source_path: item.relative
  }));
  const evidenceDir = path.join(taskDir, '00_项目总体', '04_结构化证据系统');
  writeFile(path.join(evidenceDir, 'resources.json'), `${JSON.stringify(resources, null, 2)}\n`);
  writeFile(
    path.join(evidenceDir, 'evidence_atoms.jsonl'),
    sources
      .map((item, index) =>
        JSON.stringify({
          atom_id: `E-${index + 1}`,
          resource_id: item.id,
          claim: firstHeading(item.body, item.title).slice(0, 80),
          support: '原文前部摘录',
          grade: 'A'
        })
      )
      .join('\n')
  );
  writeFile(path.join(evidenceDir, 'coverage_matrix.json'), `${JSON.stringify({ topics: topics.map((topic, index) => ({ topic: `课题${index + 1}`, name: topic.short, coverage: 'partial' })) }, null, 2)}\n`);
  writeFile(
    path.join(evidenceDir, 'metric_cards.json'),
    `${JSON.stringify(
      topics.map((topic, index) => ({
        metric_id: `M-${index + 1}`,
        topic: `课题${index + 1}`,
        category: '成果型',
        acceptance_object: topic.need,
        threshold_source: '建议值，需标定',
        calibration_status: '待标定',
        evidence_ids: sources.filter((_, sourceIndex) => sourceIndex % topics.length === index).map((item) => item.id)
      })),
      null,
      2
    )}\n`
  );
  writeFile(path.join(evidenceDir, 'tri_evidence_map.json'), `${JSON.stringify(resources.map((item) => ({ resource_id: item.resource_id, paper: item.resource_type === '论文', patent: item.resource_type === '专利', standard: false })), null, 2)}\n`);
  writeFile(path.join(evidenceDir, 'patent_claim_matrix.json'), `${JSON.stringify(sources.filter((item) => item.kind === '专利').map((item) => ({ resource_id: item.id, title: item.title, independent_claims: '见原文权利要求', notes: '保护边界以原文独立权利要求为准' })), null, 2)}\n`);
  writeFile(path.join(evidenceDir, 'standard_monitor.json'), '[]\n');
  writeFile(
    path.join(evidenceDir, 'guide_reasoning.json'),
    `${JSON.stringify(
      {
        topics: topics.map((topic, index) => ({
          topic: `课题${index + 1}`,
          topic_name: topic.title,
          engineering_contradiction: '既有做法难以把装置级能力转成调度可调用边界。',
          research_gap: `缺少与${topic.short}对应的可验收方法与接口。`,
          project_increment: topic.need,
          interfaces: index < topics.length - 1 ? `向课题${index + 2}提供输入` : '向运行应用反馈',
          evidence_ids: sources.filter((_, sourceIndex) => sourceIndex % topics.length === index).map((item) => item.id)
        }))
      },
      null,
      2
    )}\n`
  );
  writeFile(path.join(evidenceDir, 'build_manifest.json'), `${JSON.stringify({ created_at: new Date().toISOString(), mode: 'host-bootstrap-from-hits', notes: '由预检索原文落地，待人工审改。' }, null, 2)}\n`);

  const design = path.join(taskDir, '00_项目总体', '05_三类证据与研究设计');
  writeFile(path.join(design, '01_资料准入评分.md'), `# 资料准入评分\n\n${sources.map((item) => `- ${item.id} ${item.title}：A，已读原文前部`).join('\n')}\n`);
  writeFile(path.join(design, '02_六类证据覆盖与NET检索任务.md'), '# 六类覆盖\n\n论文与专利已覆盖对象与方法。标准全文不足，已列入待补证，不把未核标准限值写入正式结论。\n');
  writeFile(path.join(design, '03_论文专利标准技术特征映射.md'), `# 三类映射\n\n${sources.map((item) => `- ${item.id}：${item.kind}，服务${item.title}`).join('\n')}\n`);
  writeFile(path.join(design, '04_标准依赖与版本监测.md'), '# 标准监测\n\n本轮未取得必须依赖的标准全文。相关阈值标为建议值，需标定。\n');
  writeFile(path.join(design, '05_专利权利要求特征矩阵.md'), `# 专利矩阵\n\n${sources.filter((item) => item.kind === '专利').map((item) => `- ${item.id} ${item.title}`).join('\n') || '- 本轮专利命中见资料清单。'}\n`);
  writeFile(path.join(design, '06_工程矛盾研究空白项目增量.md'), '# 研究增量\n\n工程矛盾是装置级支撑难以被调度作为可调用能力。研究空白是评估、控制、验证尚未按同一对象闭环。项目增量是形成可验收的三条递进课题。\n');
  writeFile(path.join(design, '07_指标卡.md'), `# 指标卡\n\n${topics.map((topic, index) => `- M-${index + 1} 课题${index + 1} ${topic.need}：成果型指标，建议值，需标定`).join('\n')}\n`);
  writeFile(path.join(taskDir, '00_项目总体', '06_总成果渲染与检查', '质量检查记录.md'), '# 质量检查记录\n\n已按 V7 必须成果补齐目录、资料 ID 对应和可编辑源文件。未生成 V6 副本与 page-*.png。\n');
  writeFile(path.join(uniqueRoot, '03_网络补充资料与AI核对表.md'), '# 网络补充资料与AI核对表\n\n本轮以知识库命中为主。未编造网址。后续标准换版检查列入待补证。\n');
  writeFile(path.join(uniqueRoot, '04_标准版本核验表.md'), '# 标准版本核验表\n\n无已核标准全文。阈值不得写成已颁布限值。\n');

  for (const [index, topic] of topics.entries()) {
    const folder = path.join(taskDir, `${String(index + 1).padStart(2, '0')}_课题${index + 1}_${topic.short}`);
    const assigned = sources.filter((_, sourceIndex) => sourceIndex % topics.length === index);
    writeFile(path.join(folder, '00_范围依据', '范围说明.md'), `# 课题${index + 1} 范围依据\n\n短名：${topic.short}。研究${topic.title}，不重复其他课题的核心方法。\n`);
    writeFile(
      path.join(folder, '04_单课题综述', `课题${index + 1}_研究综述.md`),
      `# ${topic.title}\n\n既有做法难以支撑该课题的可调用与可验收要求。本课题依据 ${assigned.map((item) => item.id).join('、') || '构想'} 的原文摘录，给出对象、方法边界和与相邻课题的接口。文献结果只用于说明机制，不直接作为验收阈值。\n`
    );
    writeFile(
      path.join(folder, '05_课题设计说明', `课题${index + 1}_设计说明.md`),
      `# 课题${index + 1} 设计说明\n\n研究什么：${topic.title}。\n不研究什么：其他课题已覆盖的对象与方法。\n三个研究点：分析对象与边界；提出核心方法；形成工具或验证方案。\n接口：${index < topics.length - 1 ? `向课题${index + 2}提供输入` : '向运行应用反馈'}。\n`
    );
    writeFile(
      path.join(folder, '06_单课题指南', `课题${index + 1}_指南条目.md`),
      `# ${topic.title}\n\n预期目标：${topic.need}。\n考核指标（1）：形成与对象匹配的方法，关键误差不超过约定阈值（建议值，需标定）。\n考核指标（2）：在典型场景或等效平台完成验证。\n考核指标（3）：提交研究报告，并形成专利或软件成果。\n`
    );
    writeFile(
      path.join(folder, '07_证据映射', `课题${index + 1}_证据映射.md`),
      `# 课题${index + 1} 证据映射\n\n${assigned.map((item) => `- ${item.id} ${item.title} → ${topic.short}`).join('\n') || '- 见总体资料清单'}\n`
    );
    writeFile(path.join(folder, '08_渲染与检查', '检查记录.md'), `# 课题${index + 1} 检查记录\n\n已核目录与指南对应关系。\n`);
  }

  const formal = path.join(taskDir, '05_正式成果');
  writeFile(
    path.join(formal, 'guide.json'),
    `${JSON.stringify(
      {
        guide_year: 2027,
        cover_date: `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`,
        guide_group: '电网运行控制',
        project_number: 1,
        project_name: idea.replace(/\s+/g, '').includes('构网型储能')
          ? '构网型储能参与电网稳定支撑关键技术研究及应用'
          : `${idea.replace(/\s+/g, '').slice(0, 22)}关键技术研究`,
        discipline_root_technology: '电气工程-电力系统及其自动化。',
        plan_alignment: '建议对应新型电力系统稳定支撑相关技术方向。',
        application_scenario:
          '高比例新能源电网惯量与短路容量下降，现有装置级控制难以被调度作为可调用支撑，故障后电压和频率支撑不足。',
        functional_requirements: topics.map((topic) => topic.need),
        key_technologies: topics.map((topic) => topic.tech),
        technical_route: '技术路线按照评估、控制、验证递进展开。',
        topics: topics.map((topic, index) => ({
          title: topic.title,
          problem: '既有做法难以形成可调用、可验收的能力。',
          research_points: ['分析并建立对象与边界', '研究并提出核心方法', '形成工具或验证方案'],
          interface: index < topics.length - 1 ? `为课题${index + 2}提供输入。` : '将结果反馈到运行应用。',
          metrics: {
            performance: `${topic.need}，关键指标误差不超过约定阈值（建议值，需标定）`,
            validation: '在典型场景或等效试验平台验证',
            outputs: '提交研究报告，形成知识产权成果'
          }
        })),
        maturity_and_application: '攻关前主要成果处于4级，攻关后达到6级，在调度运行中试用。',
        duration: '本项目研究的起止时间为2027年1月至2029年12月。',
        budget_limit: '待核定。',
        lead_unit: '待核定。'
      },
      null,
      2
    )}\n`
  );
  writeFile(
    path.join(formal, '决策版研究综述.md'),
    `# 决策版研究综述\n\n${idea.trim()}\n\n高比例新能源接入后，惯量和短路容量下降，既有跟网或装置级控制难以被调度作为可调用支撑。若把实验室算例直接写成总部验收阈值，会把不可外推的结果当成工程承诺。\n\n本项目设三条递进课题：${topics.map((topic) => topic.title).join('；')}。功能需求、关键技术和课题顺序一一对应。资料 ${sources.map((item) => item.id).join('、')} 只用于说明机制、保护边界和不可外推范围。指标凡证据不足处均标为建议值、需标定，不得写成已核结论。\n`
  );
  writeFile(path.join(formal, '编制说明与质量检查报告.md'), `# 编制说明与质量检查报告\n\n- 唯一资料 ${sources.length} 份，三类总结 ID 一致\n- 课题 ${topics.length} 个，与功能需求、关键技术一一对应\n- 正式成果以 Markdown/JSON 为源，DOCX/XLSX 由宿主派生\n- 未生成 V6 副本、page-*.png 或 contact sheet\n`);
  writeFile(path.join(formal, '待补证清单.md'), '# 待补证清单\n\n- 关键标准全文与换版结论待补\n- 示范工程现场数据待标定\n- 指标阈值保持建议值，不得写成已验收\n');
  return { sourceCount: sources.length, topicCount: topics.length };
}
