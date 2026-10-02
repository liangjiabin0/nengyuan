/**
 * 中国专利 PDF 文本解析：抽出著录项，并生成 agent 可检索的结构化全文。
 */

const CN_PUB_RE = /\bCN[\s-]?(\d{7,13})[\s-]?([A-Z])?\b/i;
const FILE_CN_RE = /CN[\s_-]?(\d{7,13})[\s_-]?([A-Z])?/i;

export type CnPatentMeta = {
  pubNo: string;
  appNo: string;
  title: string;
  patentType: string;
  applicant: string;
  inventors: string;
  abstract: string;
  ipc: string[];
  appDate: string;
  pubDate: string;
};

function compact(text: string) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\t\f\v\u00a0\u3000]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function joinLines(text: string) {
  return compact(text)
    .replace(/\n+/g, '')
    .replace(/[ \u00a0\u3000]+/g, '')
    .trim();
}

function peopleList(text: string) {
  return compact(text)
    .replace(/[　\t]+/g, ' ')
    .replace(/[，,、；;]+/g, '；')
    .replace(/\s+/g, '；')
    .replace(/；{2,}/g, '；')
    .replace(/^；|；$/g, '')
    .trim();
}

export function normalizeCnPubNo(raw: string) {
  const match = CN_PUB_RE.exec(String(raw || '')) || FILE_CN_RE.exec(String(raw || ''));
  if (!match) return '';
  return `CN${match[1]}${(match[2] || '').toUpperCase()}`;
}

function capture(text: string, start: RegExp, ends: RegExp[], maxLen = 2500) {
  const match = start.exec(text);
  if (!match) return '';
  const from = match.index + match[0].length;
  let to = Math.min(text.length, from + maxLen);
  const tail = text.slice(from, to);
  let cut: number | null = null;
  for (const end of ends) {
    const cloned = new RegExp(end.source, end.flags.replace('g', ''));
    const hit = cloned.exec(tail);
    if (hit && hit.index >= 0 && (cut === null || hit.index < cut)) cut = hit.index;
  }
  if (cut !== null) to = from + cut;
  return compact(text.slice(from, to));
}

function onlyDate(value: string) {
  return (/((?:19|20)\d{2}[.\-/年]\d{1,2}[.\-/月]\d{1,2}日?)/.exec(value) || [])[1] || '';
}

function cleanTitle(value: string) {
  return joinLines(value)
    .replace(/[（(]\s*57\s*[)）].*$/, '')
    .replace(/摘要.*$/, '')
    .replace(/权利要求.*$/, '')
    .trim();
}

function cleanPeople(value: string) {
  return peopleList(value.replace(/[（(]\s*\d{2}\s*[)）].*$/g, '').replace(/专利代理.*$/g, ''));
}

function inferPatentType(text: string) {
  if (/实用新型/.test(text)) return '实用新型';
  if (/外观设计/.test(text)) return '外观设计';
  if (/发明授权|授权公告/.test(text)) return '发明授权';
  if (/发明专利申请|发明公开|发明专利/.test(text)) return '发明公开';
  return '发明公开';
}

export function parseCnPatentText(text: string, filePath = ''): CnPatentMeta {
  const raw = String(text || '');
  const pubNo =
    normalizeCnPubNo(filePath) ||
    normalizeCnPubNo(raw) ||
    '';

  const title =
    cleanTitle(
      capture(raw, /\(\s*54\s*\)\s*(?:发明|实用新型|外观设计)?名称/i, [/\(\s*57\s*\)/, /摘要/, /\(\s*51\s*\)/], 400)
    ) ||
    cleanTitle(capture(raw, /(?:发明|实用新型|外观设计)名称/, [/\(\s*57\s*\)/, /摘要/], 400)) ||
    '';

  const abstract = compact(
    capture(raw, /\(\s*57\s*\)\s*摘要/, [/权利要求书/, /权\s*利\s*要\s*求/, /\n1\./, /CN\s+\d{7,13}/], 1200) ||
      capture(raw, /摘要/, [/权利要求书/, /权\s*利\s*要\s*求/, /\n1\./], 1200)
  )
    .replace(/权利要求书.*$/s, '')
    .slice(0, 2000);

  const applicant = compact(
    capture(
      raw,
      /\(\s*7[13]\s*\)\s*(?:申请|专利权?)人/,
      [/地址/, /\(\s*72\s*\)/, /\(\s*74\s*\)/, /\(\s*51\s*\)/],
      200
    )
  )
    .split('\n')[0]
    ?.replace(/^(?:申请|专利权?)人/, '')
    .trim() || '';

  const inventors = cleanPeople(
    capture(raw, /\(\s*72\s*\)\s*发明人/, [/\(\s*74\s*\)/, /\(\s*51\s*\)/, /\(\s*57\s*\)/, /专利代理/], 300)
  );

  const appNo = (
    capture(raw, /\(\s*21\s*\)\s*申请号/, [/\(\s*22\s*\)/, /\n/]) ||
    /申请号\s*[:：]?\s*([0-9.X]+)/i.exec(raw)?.[1] ||
    ''
  ).replace(/申请号/g, '').trim();

  const appDate = (
    capture(raw, /\(\s*22\s*\)\s*申请日/, [/\(\s*7/, /\(\s*43\s*\)/, /\n/]) ||
    /申请日\s*[:：]?\s*(\d{4}[.\-/]?\d{1,2}[.\-/]?\d{1,2})/.exec(raw)?.[1] ||
    ''
  ).replace(/申请日/g, '').trim();

  const pubDate =
    onlyDate(capture(raw, /\(\s*43\s*\)\s*申请公布日/, [/\(\s*21\s*\)/, /\(\s*22\s*\)/], 80)) ||
    onlyDate(capture(raw, /\(\s*45\s*\)\s*授权公告日/, [/\(\s*21\s*\)/, /\(\s*22\s*\)/], 80)) ||
    onlyDate((raw.match(/CN\s*\d{7,13}\s*[A-Z][\s\S]{0,40}?(\d{4}\.\d{1,2}\.\d{1,2})/) || [])[1] || '');

  const ipcBlock = capture(raw, /\(\s*51\s*\)\s*Int\.?\s*Cl\.?/i, [/\(\s*54\s*\)/, /发明名称/, /\(\s*57\s*\)/]);
  const ipc = [...ipcBlock.matchAll(/[A-HY]\d{2}[A-Z]?\s*\d{1,4}\s*\/\s*\d{1,4}/g)].map((item) =>
    item[0].replace(/\s+/g, ' ').trim()
  );

  return {
    pubNo,
    appNo,
    title: title.slice(0, 200),
    patentType: inferPatentType(raw),
    applicant: applicant.slice(0, 200),
    inventors: inventors.slice(0, 400),
    abstract,
    ipc: [...new Set(ipc)].slice(0, 16),
    appDate,
    pubDate
  };
}

export function patentKeywords(meta: CnPatentMeta) {
  const year = (meta.pubDate || meta.appDate).match(/\d{4}/)?.[0] || '';
  return [meta.patentType, meta.pubNo, year, ...meta.ipc].filter(Boolean).join('；');
}

export function patentPaperKey(meta: CnPatentMeta, fileHash: string) {
  return meta.pubNo ? `patent:${meta.pubNo}` : `patent:${fileHash.slice(0, 24)}`;
}

export function structurePatentText(raw: string, meta: CnPatentMeta) {
  const lines = [
    '### 著录项目',
    '',
    `* 专利名称：${meta.title || '未解析到'}`,
    `* 专利类型：${meta.patentType}`,
    `* 公开号：${meta.pubNo || '未解析到'}`,
    `* 申请号：${meta.appNo || '未解析到'}`,
    `* 申请日：${meta.appDate || '未解析到'}`,
    `* 公开日：${meta.pubDate || '未解析到'}`,
    `* 申请人：${meta.applicant || '未解析到'}`,
    `* 发明人：${meta.inventors || '未解析到'}`,
    `* IPC：${meta.ipc.join('；') || '未解析到'}`,
    '',
    '### 摘要',
    '',
    meta.abstract || '未在文本层解析到摘要。',
    '',
    '### 专利全文',
    '',
    compact(raw)
  ];
  return lines.join('\n');
}

export function isCnPatentSource(filePath: string, text = '') {
  const posix = filePath.replace(/\\/g, '/');
  if (/IEEE Transactions on [^/]+/i.test(posix) || /IEEE订阅期刊/.test(posix)) return false;
  return /CN[\s_-]?\d{7,13}/i.test(filePath) || /\(\s*54\s*\)\s*发明名称/.test(text) || /中华人民共和国国家知识产权局/.test(text);
}
