import { normalizeKeyText, normalizeText } from '../text';

const TITLE_SUFFIXES = [
  '教授',
  '副教授',
  '讲师',
  '研究员',
  '副研究员',
  '院士',
  '博士',
  '硕士',
  '老师',
  '先生',
  '女士',
  '主任',
  '院长',
  '所长',
  '高工',
  '工程师'
];

const INSTITUTION_NOISE = [
  '有限责任公司',
  '股份有限公司',
  '有限公司',
  '集团公司',
  '集团',
  '研究院',
  '研究所',
  '大学',
  '学院',
  '中心'
];

/** 全角/空白/控制字符清洗，保留可读原名形态 */
export function cleanDisplayName(value?: string) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 人名：去职称后缀、括号备注 */
export function canonicalizePerson(value?: string) {
  let name = cleanDisplayName(value);
  if (!name) return '';
  name = name.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const suffix of TITLE_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length + 1) {
      name = name.slice(0, -suffix.length).trim();
    }
  }
  return normalizeKeyText(name);
}

/** 机构：去常见后缀噪声，便于对齐 */
export function canonicalizeInstitution(value?: string) {
  let name = cleanDisplayName(value);
  if (!name) return '';
  name = name.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
  const key = normalizeKeyText(name);
  // 保留完整规范化键；另生成去噪声变体供别名
  return key;
}

export function institutionAliasVariants(value?: string) {
  const base = cleanDisplayName(value);
  if (!base) return [] as string[];
  const variants = new Set<string>([base, normalizeKeyText(base)]);
  const stripped = normalizeKeyText(base);
  for (const noise of INSTITUTION_NOISE) {
    const n = normalizeKeyText(noise);
    if (stripped.endsWith(n) && stripped.length > n.length + 1) {
      variants.add(stripped.slice(0, -n.length));
    }
  }
  return [...variants].filter(Boolean);
}

/** 关键词 / 学科 */
export function canonicalizeKeyword(value?: string) {
  return normalizeKeyText(cleanDisplayName(value));
}

/** 论文/成果标题：去标点与空白 */
export function canonicalizeTitle(value?: string) {
  return normalizeKeyText(
    cleanDisplayName(value)
      .replace(/[《》〈〉「」『』【】\[\]]/g, '')
      .replace(/[:：;；.。!！?？,，]/g, ' ')
  );
}

export function canonicalizeByType(type: string, value?: string) {
  switch (type) {
    case 'person':
      return canonicalizePerson(value);
    case 'institution':
      return canonicalizeInstitution(value);
    case 'keyword':
    case 'discipline':
    case 'algorithm':
      return canonicalizeKeyword(value);
    case 'paper':
    case 'output':
    case 'project':
      return canonicalizeTitle(value) || normalizeKeyText(value);
    default:
      return normalizeKeyText(cleanDisplayName(value));
  }
}

export function aliasVariantsForType(type: string, value?: string) {
  const display = cleanDisplayName(value);
  if (!display) return [] as string[];
  const canon = canonicalizeByType(type, display);
  const variants = new Set<string>([display, normalizeText(display), canon].filter(Boolean));
  if (type === 'institution') {
    for (const v of institutionAliasVariants(display)) variants.add(v);
  }
  if (type === 'person') {
    const person = canonicalizePerson(display);
    if (person) variants.add(person);
  }
  return [...variants];
}
