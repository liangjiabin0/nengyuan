/**
 * 校验成熟 patent skills 已安装且 OpenCode 可列出/加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const skillsRoot = path.join(root, '.opencode', 'skills');

const required = [
  'patent-aris-structure',
  'patent-aris-claims',
  'patent-aris-specification',
  'patent-aris-review',
  'patent-ref-cn-format',
  'patent-ref-principles',
  'patent-disclosure',
  'patent-claims',
  'patent-specification',
  'patent-audit',
  'SOURCES.md'
];

const missing: string[] = [];
for (const name of required) {
  const target = name.endsWith('.md')
    ? path.join(skillsRoot, name)
    : path.join(skillsRoot, name, 'SKILL.md');
  if (!fs.existsSync(target)) missing.push(name);
}

const adapters = ['patent-disclosure', 'patent-claims', 'patent-specification', 'patent-audit'];
const adapterIssues: string[] = [];
for (const name of adapters) {
  const text = fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
  if (!/patent-aris-|patent-ref-/.test(text)) {
    adapterIssues.push(`${name} 未引用成熟 skill`);
  }
  if (!/adapts:|成熟/.test(text)) {
    adapterIssues.push(`${name} 缺少成熟来源标注`);
  }
}

const sources = fs.readFileSync(path.join(skillsRoot, 'SOURCES.md'), 'utf8');
if (!/wanshuiyin|ARIS|MIT/.test(sources)) {
  adapterIssues.push('SOURCES.md 缺少上游归属');
}

console.log(JSON.stringify({ missing, adapterIssues, skillCount: fs.readdirSync(skillsRoot).length }, null, 2));
if (missing.length || adapterIssues.length) process.exit(1);

async function checkOpenCode() {
  const statePath = path.join(root, 'storage', 'opencode-sidecar.json');
  if (!fs.existsSync(statePath)) {
    console.log('SKIP_OPENCODE_LIST: no sidecar state');
    return;
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  const auth = Buffer.from(`${state.username}:${state.password}`).toString('base64');
  const url = `${String(state.baseUrl).replace(/\/$/, '')}/skill?directory=${encodeURIComponent(state.workingDirectory)}`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  const body = await res.text();
  const names = [...body.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  const patentNames = names.filter((n) => n.startsWith('patent-'));
  const needOnline = [
    'patent-aris-claims',
    'patent-aris-review',
    'patent-ref-cn-format',
    'patent-claims'
  ];
  const onlineMissing = needOnline.filter((n) => !patentNames.includes(n));
  console.log(JSON.stringify({
    http: res.status,
    patentSkillCount: patentNames.length,
    patentNames: patentNames.sort(),
    onlineMissing
  }, null, 2));
  if (res.status !== 200 || onlineMissing.length) process.exit(1);
}

checkOpenCode()
  .then(() => {
    console.log('MATURE_SKILLS_TEST=PASS');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
