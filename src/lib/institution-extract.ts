const INSTITUTION_BODY = /[\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院)/g;
const INSTITUTION_NAME = /[\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院)/;
const INSTITUTION_NOISE_IN_NAME = /哪些|库里|库里面|什么|里面|信息|数据|请问|关于|有|的|哪些|哪一/;
const INSTITUTION_ALIASES: Array<[RegExp, string]> = [
  [/清华(?:大学)?/, '清华大学'],
  [/北京大学|北大/, '北京大学'],
  [/上海交通大学|上海交大|上交/, '上海交通大学'],
  [/西安交通大学|西安交大|西交/, '西安交通大学'],
  [/中国科学技术大学|中科大/, '中国科学技术大学'],
  [/中国科学院大学|国科大/, '中国科学院大学'],
  [/华北电力大学|华电/, '华北电力大学']
];

/** 从自然语言问题中提取机构名，如「库里面有哪些平顶山学院的信息」→ 平顶山学院 */
export function extractInstitutionNames(text: string): string[] {
  const found = new Set<string>();
  const normalized = String(text || '').replace(/\s+/g, '');

  for (const [pattern, canonicalName] of INSTITUTION_ALIASES) {
    if (pattern.test(normalized)) found.add(canonicalName);
  }

  const patterns = [
    /库里面?有哪些([\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院))/g,
    /数据库里?有哪些([\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院))/g,
    /(?:哪一些|关于)([\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院))/g,
    /有(?:哪些|那些)([\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院))/g,
    /([\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院))(?:的|有|相关|信息|数据|记录|导师|项目|论文)/g
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const candidate = sanitizeInstitutionName(match[1] || '');
      if (candidate) found.add(candidate);
    }
  }

  if (!found.size) {
    for (const match of normalized.matchAll(INSTITUTION_BODY)) {
      const candidate = sanitizeInstitutionName(match[0]);
      if (candidate) found.add(candidate);
    }
  }

  return [...found];
}

export function sanitizeInstitutionName(raw: string): string {
  const name = String(raw || '').trim();
  if (!name || !INSTITUTION_NAME.test(name)) return '';

  const suffix = name.match(/([\u4e00-\u9fa5]{2,10}(?:大学|学院|研究院))$/)?.[1];
  if (!suffix) return '';

  const stem = suffix.replace(/(?:大学|学院|研究院)$/, '');
  if (!stem || INSTITUTION_NOISE_IN_NAME.test(stem)) return '';
  if (stem.length < 2 || stem.length > 10) return '';

  return suffix;
}

export function isInstitutionLookupQuestion(question: string) {
  const q = String(question || '');
  return /库里有|库里面|数据库里|库里有什么|(?:哪些|那些).{0,24}(?:大学|学院|研究院)/.test(q)
    || /(?:大学|学院|研究院).{0,12}(?:信息|数据|记录|内容|有什么)/.test(q)
    || (/有(?:哪些|那些)|有什么/.test(q) && extractInstitutionNames(q).length > 0);
}

export function isListFollowUp(question: string) {
  const q = String(question || '');
  if (isInstitutionLookupQuestion(q)) return false;
  if (/库里|数据库|什么表|能查什么|概览|规模/.test(q)) return false;
  if (/还有哪些|还有哪|另外还有哪些|再有哪些|除.*还有|再举|再列|再补充/.test(q)) return true;
  if (/哪些/.test(q) && !/有哪些|哪一些/.test(q) && /还有|除|另外|再|继续/.test(q)) return true;
  return /还有|其他|另外|继续|以及|有没有别的|同样|除了|其余|列举|列出/.test(q)
    && !/^有哪些/.test(q);
}
