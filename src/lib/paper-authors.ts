const AUTHOR_BLOCK_STOP = /(?:^|\n)\s*摘要|(?:^|\n)\s*Abstract|(?:^|\n)\s*关键词|(?:^|\n)\s*Key\s*words|(?:^|\n)\s*引言|(?:^|\n)\s*Introduction/i;
const CHINESE_NAME = /[\u4e00-\u9fa5]{2,4}/g;
const INVALID_AUTHORS = /研究|方法|系统|分析|优化|基于|面向|考虑|University|College|摘要|关键词|中图分类|综述|展望|策略|特性|评估|仿真|建模|控制|调度|网络|电网|电力|新能源|参数|目前|近年来|因此|然而|同时|首先|促进|储能|数值|机理|刚性|绝缘|整体|发展|求解|腐蚀|动态|响应|故障|选相|博弈|吸引/i;
const INVALID_PERSON_NAMES = new Set([
  '目前', '近年来', '因此', '然而', '同时', '首先', '其次', '此外', '另外', '其中', '本文', '该文',
  '参数', '数值', '促进', '储能', '电网', '系统', '方法', '研究', '分析', '优化', '控制', '频率',
  '电压', '电流', '功率', '能量', '模型', '算法', '结果', '问题', '特性', '影响', '效果', '过程',
  '交流电网', '优化调度', '研究进展', '影响研究', '抑制方法研究', '控制策略研究', '评估方法研究'
]);

export function isValidPersonName(name: string) {
  const value = String(name || '').trim();
  if (!/^[\u4e00-\u9fa5]{2,4}$/u.test(value)) return false;
  if (INVALID_PERSON_NAMES.has(value)) return false;
  if (/研究|方法|系统|分析|优化|控制|调度|策略|展望|综述|电网|电力|参数|数值|模型|网络|故障|仿真/.test(value)) return false;
  return true;
}

export function authorsFieldLooksValid(authors: string) {
  const text = String(authors || '').trim();
  if (!text || text.length > 120) return false;
  if (INVALID_AUTHORS.test(text)) return false;
  if (/[A-Za-z]{4,}/.test(text) && !/[\u4e00-\u9fa5]{2}/.test(text)) return false;
  const names = parseAuthorNamesFromField(text);
  return names.length >= 1 && names.length <= 12;
}

function parseAuthorNamesFromField(authors: string) {
  return String(authors)
    .split(/[，,;；、\s]+/)
    .map((part) => part.replace(/\d+/g, '').trim())
    .filter((part) => isValidPersonName(part));
}

export function parseAuthorNamesFromText(text: string, maxChars = 2800): string[] {
  const header = String(text || '').slice(0, maxChars);
  const beforeStop = header.split(AUTHOR_BLOCK_STOP)[0] || header;

  for (const line of beforeStop.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 100) continue;
    if (/大学|学院|公司|研究所|邮编|Email|@|Vol\.|No\.|文章编号|中图分类|Power System/i.test(trimmed)) continue;

    if (/[\u4e00-\u9fa5]{2,4}\s*\d+[，,、]/.test(trimmed)) {
      const names = [...trimmed.matchAll(/([\u4e00-\u9fa5]{2,4})\s*\d+/g)]
        .map((m) => m[1])
        .filter((name) => isValidPersonName(name));
      if (names.length >= 2) return [...new Set(names)];
    }

    const plainNames = [...trimmed.matchAll(/([\u4e00-\u9fa5]{2,4})(?:\s*\d+)?(?=[，,、\s]|$)/g)]
      .map((m) => m[1])
      .filter((name) => isValidPersonName(name));
    if (plainNames.length >= 2 && plainNames.length <= 10 && /[，,、]/.test(trimmed)) {
      return [...new Set(plainNames)];
    }
  }

  return [];
}

export function parseAuthorsFromRecord(authors: string, headerText?: string) {
  if (authorsFieldLooksValid(authors)) {
    const fromField = parseAuthorNamesFromField(authors);
    if (fromField.length) return fromField;
  }
  if (headerText) return parseAuthorNamesFromText(headerText);
  return [];
}

export function authorPosition(authors: string[], name: string) {
  const idx = authors.findIndex((author) => author === name || author.includes(name) || name.includes(author));
  return idx >= 0 ? idx + 1 : 0;
}

export function formatAuthorRank(authors: string[], name: string) {
  const pos = authorPosition(authors, name);
  if (!authors.length) return { found: false, position: 0, authors, summary: '未能解析作者列表' };
  if (!pos) return { found: false, position: 0, authors, summary: `${name} 不在作者列表中（${authors.join('、')}）` };
  return { found: true, position: pos, authors, summary: `${name} 为第 ${pos} 作者（共 ${authors.length} 人：${authors.join('、')}）` };
}
