const GENERIC_TERMS = new Set([
  '研究',
  '分析',
  '方法',
  '模型',
  '系统',
  '技术',
  '应用',
  '控制',
  '优化',
  '计算',
  '预测',
  '结果',
  '问题',
  '相关研究',
  '研究方法',
  '本文方法',
  '一种方法',
  '中图分类',
  '中图分类号',
  '套餐',
  '发明公开',
  '实用新型',
  'energy',
  'power',
  'heat',
  'line',
  'deep',
  'low',
  'high',
  'new',
  'data',
  'grid',
  'load',
  'fault',
  'wind',
  'solar',
  'dynamic',
  'modular',
  'pressure',
  'knowledge',
  'temperature',
  'transformer',
  'frequency',
  'voltage',
  'current',
  'control',
  'system',
  'model',
  'method',
  'network',
  'storage',
  'market',
  'partial',
  'snapshot',
  'hydrogen',
  'disturbance',
  'hybrid',
  'oscillation',
  'resilience',
  'defective text'
]);

export function normalizeTermName(value: string) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/^(?:关键词|关键字|key\s*words?)\s*[:：]\s*/i, '')
    .replace(/[；;，,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 只允许简短、可独立理解的科研术语进入关键词网络。 */
export function isMeaningfulTermName(value: string, type = 'keyword') {
  const term = normalizeTermName(value);
  const maxLength = type === 'algorithm' ? 18 : type === 'discipline' ? 24 : 28;
  if (!term || term.length < 2 || term.length > maxLength) return false;
  if (GENERIC_TERMS.has(term.toLowerCase())) return false;
  if (/[\uFFFD\u0000-\u001f]/u.test(term)) return false;
  if (/https?:\/\/|www\.|@|\.(?:com|cn|org)\b/i.test(term)) return false;
  if (/[-/]\s*$|\b(?:and|or|the|of|for|with|to|in|on)\s*$/i.test(term)) return false;
  if (/[，。；：！？。…《》“”"()[\]{}<>]/u.test(term)) return false;
  if (/^(?:的|在|将|以|从|本文|本研究|该研究|提出|建立|构建|形成|耦合下|基于|一种|采用|使用|通过|针对|面向|考虑|利用|实现|进行|可以|能够|以及|及其|其中|该|对)/u.test(term)) return false;
  if (/(?:方面|情况下|过程中|结果表明|如图|所示|其中|因此|为例|等等)$/u.test(term)) return false;
  if (/[\u4e00-\u9fff](?:的|了|着|过|以及|并且|从而|使得|用于|在内)[\u4e00-\u9fff]/u.test(term)) return false;
  if (/(?:下基于|中采用|中使用|中进行|中的|下的|时的)/u.test(term)) return false;

  const hanCount = (term.match(/[\u3400-\u9fff]/gu) || []).length;
  const latinCount = (term.match(/[A-Za-z]/g) || []).length;
  const meaningfulCount = hanCount + latinCount + (term.match(/\d/g) || []).length;
  if (meaningfulCount / term.length < 0.65) return false;
  if (hanCount > 0 && hanCount < 2 && latinCount === 0) return false;

  // 英文术语至少是可独立理解的短语或常见缩写，拒绝截断碎片。
  if (latinCount > 0 && hanCount === 0) {
    const words = term.split(/\s+/).filter(Boolean);
    if (words.length === 1) {
      if (term.length < 10 && !/[0-9-]/.test(term)) return false;
      if (!/^[A-Za-z][A-Za-z0-9+.#-]{2,}$/u.test(term)) return false;
      if (/^(?:low|high|high-|new|deep|line|data|grid|load|wind|heat|power|energy|type|partial)-?$/i.test(term)) return false;
    } else if (words.length === 2 && /^(?:new|high|low|deep|type|data|power|energy)$/i.test(words[0]) && /^(?:type|system|data|power|energy|learning|network)$/i.test(words[1])) {
      // 拒绝过于泛化的二字英文短语，例如 new type / power system 可保留更具体的三词以上。
      if (!/power system|energy system|distribution network/i.test(term)) return false;
    } else if (!/^[A-Za-z][A-Za-z0-9+.#-]*(?: [A-Za-z0-9+.#()-]+){0,5}$/u.test(term)) {
      return false;
    }
    if (words.some((word) => /-$/.test(word) || word.length <= 1)) return false;
  }

  if (type === 'algorithm') {
    if (term.length < 3) return false;
    if (hanCount > 0 && term.length > 14) return false;
    if (/^(?:但|然而|此时|其|该|种|介绍|提出|提|则|具体|完善|桥|器)/u.test(term)) return false;
    if (/(?:不需要|需要改变|可计算|进行控制|分析方法与控制|方法与控制)/u.test(term)) return false;
  }
  return true;
}
