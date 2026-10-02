import type {
  AuditIssue,
  InventionDisclosure,
  PatentAudit,
  PatentDraft,
  PatentDrawingsBundle
} from './types';

export function countAbstractCharacters(value: string) {
  return value.replace(/\s+/g, '').length;
}

/** 把“权利要求1 …”等写法归一成 “1. …”，并给无编号分块自动编号。 */
export function normalizeClaimsText(value: string): string {
  const trimmed = value.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return '';
  const withArabic = trimmed.replace(
    /(?:^|\n)\s*权利要求\s*(\d+)\s*[.、．:：]?\s*/g,
    '\n$1. '
  ).trim();
  if (splitClaims(withArabic).length) return withArabic;

  const blocks = withArabic.split(/\n\s*\n+/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length < 2) return withArabic;
  return blocks.map((block, index) => {
    if (/^\d+[.、．]/.test(block)) return block;
    return `${index + 1}. ${block}`;
  }).join('\n\n');
}

export function splitClaims(value: string) {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  const matches = [...normalized.matchAll(/(?:^|\n)\s*(\d+)[.、．]\s*/g)];
  if (!matches.length) return [] as Array<{ number: number; text: string }>;
  return matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index || normalized.length : normalized.length;
    return {
      number: Number(match[1]),
      text: normalized.slice(start, end).trim()
    };
  });
}

function issue(
  id: string,
  severity: AuditIssue['severity'],
  category: string,
  message: string,
  location?: string,
  suggestion?: string
): AuditIssue {
  return { id, severity, category, message, location, suggestion };
}

function deterministicSupportMatrix(
  claims: ReturnType<typeof splitClaims>,
  disclosure: InventionDisclosure
): PatentAudit['supportMatrix'] {
  const anchors = new Set(disclosure.sourceAnchors.map((anchor) => anchor.id));
  return claims.map((claim) => {
    const featureHits = [...disclosure.essentialFeatures, ...disclosure.optionalFeatures]
      .filter((feature) => {
        const terms = String(feature?.name || '').split(/[、，,\s]/).filter((term) => term.length >= 2);
        return terms.some((term) => claim.text.includes(term));
      });
    const evidence = [...new Set(featureHits.flatMap((feature) => feature.anchors))]
      .filter((anchor) => anchors.has(anchor));
    return {
      claim: claim.number,
      supported: claim.number === 1 ? evidence.length >= 1 : featureHits.length >= 1,
      evidence,
      note: featureHits.length
        ? `匹配交底特征：${featureHits.map((feature) => feature.name).join('、')}`
        : '未通过术语匹配找到直接交底特征，需模型复核。'
    };
  });
}

function asDraftText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>;
        if (row.figureNumber != null && typeof row.description === 'string') {
          return `图${row.figureNumber}：${row.description}`;
        }
        if (typeof row.description === 'string') return row.description;
      }
      return String(item ?? '');
    }).filter(Boolean).join('\n');
  }
  return String(value);
}

export function validatePatentDraft(
  draft: PatentDraft,
  disclosure: InventionDisclosure,
  drawings?: PatentDrawingsBundle | null
): PatentAudit {
  const issues: AuditIssue[] = [];
  const title = asDraftText(draft.title);
  const abstract = asDraftText(draft.abstract);
  const embodiments = asDraftText(draft.embodiments);
  const drawingDescription = asDraftText(draft.drawingDescription);
  const abstractLength = countAbstractCharacters(abstract);
  if (!title.trim()) {
    issues.push(issue('D-TITLE-EMPTY', 'error', 'completeness', '缺少发明名称。', '发明名称'));
  } else if (title.replace(/\s+/g, '').length > 60) {
    issues.push(issue('D-TITLE-LONG', 'warning', 'clarity', '发明名称偏长，可能不能简明反映主题。', '发明名称'));
  }
  if (!abstract.trim()) {
    issues.push(issue('D-ABSTRACT-EMPTY', 'error', 'completeness', '缺少说明书摘要。', '说明书摘要'));
  } else if (abstractLength > 300) {
    issues.push(issue(
      'D-ABSTRACT-LONG',
      'error',
      'format',
      `说明书摘要为 ${abstractLength} 字，超过 300 字上限。`,
      '说明书摘要',
      '压缩背景描述，保留技术问题、核心方案和用途。'
    ));
  }

  const sectionChecks: Array<[keyof PatentDraft, string]> = [
    ['technicalField', '技术领域'],
    ['backgroundArt', '背景技术'],
    ['inventionSummary', '发明内容'],
    ['embodiments', '具体实施方式']
  ];
  for (const [key, label] of sectionChecks) {
    const value = asDraftText(draft[key]);
    if (!value.trim()) {
      issues.push(issue(`D-SECTION-${String(key)}`, 'error', 'completeness', `缺少${label}。`, label));
    }
  }
  if (embodiments.replace(/\s+/g, '').length < 800) {
    issues.push(issue(
      'D-EMBODIMENT-SHORT',
      'warning',
      'sufficiency',
      '具体实施方式较短，需按技术复杂度复核是否足以实施全部必要技术特征。',
      '具体实施方式'
    ));
  }

  const drawingCount = drawings?.assets?.length || draft.drawings?.length || 0;
  if (!drawingDescription.trim() || drawingDescription.trim() === '无') {
    issues.push(issue(
      drawingCount ? 'D-DRAWING-DESC-EMPTY' : 'D-DRAWING-MISSING',
      drawingCount ? 'error' : 'warning',
      'drawings',
      drawingCount ? '已有说明书附图，但缺少附图说明。' : '缺少说明书附图与附图说明，完整申请文件通常需要附图。',
      '附图说明'
    ));
  }
  if (drawingCount === 0) {
    issues.push(issue(
      'D-DRAWING-FILES-MISSING',
      'info',
      'drawings',
      '当前方案未生成说明书附图；请结合技术主题判断是否需要附图。',
      '说明书附图'
    ));
  }
  const abstractFigure = asDraftText(draft.abstractFigure);
  if (drawingCount > 0 && (!abstractFigure.trim() || abstractFigure.trim() === '无')) {
    issues.push(issue(
      'D-ABSTRACT-FIGURE',
      'warning',
      'drawings',
      '存在说明书附图但摘要附图未指定图号。',
      '说明书摘要'
    ));
  }

  const claims = splitClaims(asDraftText(draft.claims));
  if (!claims.length) {
    issues.push(issue('D-CLAIMS-EMPTY', 'error', 'claims', '未识别到按序编号的权利要求。', '权利要求书'));
  } else {
    if (claims.length < 5) {
      issues.push(issue(
        'D-CLAIMS-FEW',
        'warning',
        'claims',
        `权利要求仅 ${claims.length} 项，请复核是否具备足够的回退层级。`,
        '权利要求书',
        '根据技术贡献补充有来源支持的从属项，不为凑数量增加内容。'
      ));
    }
    if (claims.length > 25) {
      issues.push(issue(
        'D-CLAIMS-MANY',
        'warning',
        'claims',
        `权利要求为 ${claims.length} 项，建议结合保护层级和申请成本复核是否需要收敛。`,
        '权利要求书'
      ));
    }
    const hasMethod = claims.some((claim) => /方法/.test(claim.text.slice(0, 80)));
    const hasSystem = claims.some((claim) => /系统|装置|设备|介质/.test(claim.text.slice(0, 80)));
    if (!hasMethod || !hasSystem) {
      issues.push(issue(
        'D-CLAIMS-TYPE',
        'info',
        'claims',
        '当前未同时识别到方法与系统/装置/介质权利要求；是否需要多客体保护应按发明主题决定。',
        '权利要求书'
      ));
    }
    claims.forEach((claim, index) => {
      const expected = index + 1;
      if (claim.number !== expected) {
        issues.push(issue(
          `D-CLAIM-NUM-${claim.number}`,
          'error',
          'format',
          `权利要求编号不连续，应为 ${expected}，实际为 ${claim.number}。`,
          `权利要求${claim.number}`
        ));
      }
      const dependencies = [...claim.text.matchAll(/权利要求\s*(\d+)(?:\s*[-至到、,]\s*(\d+))?/g)]
        .flatMap((match) => [Number(match[1]), match[2] ? Number(match[2]) : 0])
        .filter(Boolean);
      // 独立权常见写法：“一种…系统，其特征在于，所述系统包括…”——前 40 字可含“所述”，不能据此判从属权。
      const looksDependent = /^(?:根据|如权利要求)/.test(claim.text.trim())
        || /^[^。]{0,30}根据权利要求/.test(claim.text.trim());
      if (claim.number > 1 && looksDependent && !dependencies.length) {
        issues.push(issue(
          `D-CLAIM-REF-MISSING-${claim.number}`,
          'error',
          'dependency',
          '从属权利要求未明确引用在前权利要求。',
          `权利要求${claim.number}`
        ));
      }
      if (dependencies.some((dependency) => dependency >= claim.number)) {
        issues.push(issue(
          `D-CLAIM-REF-FUTURE-${claim.number}`,
          'error',
          'dependency',
          '权利要求引用了自身或在后的权利要求。',
          `权利要求${claim.number}`
        ));
      }
      const periods = (claim.text.match(/[。]/g) || []).length;
      if (periods !== 1 || !claim.text.endsWith('。')) {
        issues.push(issue(
          `D-CLAIM-PERIOD-${claim.number}`,
          'warning',
          'format',
          '每项权利要求应作为一个完整句子并仅以一个句号结束。',
          `权利要求${claim.number}`
        ));
      }
      if (/等等|等参数|等内容|大约|较高|较低|适当|必要时|优选|最好|例如|可以/.test(claim.text)) {
        issues.push(issue(
          `D-CLAIM-VAGUE-${claim.number}`,
          'warning',
          'clarity',
          '权利要求包含相对、示例或可选择性措辞，可能导致保护范围不清楚。',
          `权利要求${claim.number}`,
          '改为可验证的结构、步骤、关系或参数范围。'
        ));
      }
      if (/\[待|待确认|TBD|TODO|未恢复/i.test(claim.text)) {
        issues.push(issue(
          `D-CLAIM-PLACEHOLDER-${claim.number}`,
          'error',
          'support',
          '权利要求中存在未确认占位符。',
          `权利要求${claim.number}`
        ));
      }
    });
  }

  for (const placeholder of ['[待确认]', 'TBD', 'TODO']) {
    if (JSON.stringify(draft).includes(placeholder)) {
      issues.push(issue(
        `D-PLACEHOLDER-${placeholder}`,
        'warning',
        'completeness',
        `申请文件仍包含占位符“${placeholder}”。`
      ));
    }
  }

  const supportMatrix = deterministicSupportMatrix(claims, disclosure);
  supportMatrix
    .filter((entry) => !entry.supported)
    .forEach((entry) => issues.push(issue(
      `D-SUPPORT-${entry.claim}`,
      'info',
      'support',
      `权利要求${entry.claim}未通过确定性术语匹配找到交底书支持锚点，需语义复核。`,
      `权利要求${entry.claim}`,
      '核对该特征是否由源文档直接、毫无疑义地公开。'
    )));

  const penalty = issues.reduce((sum, current) => {
    if (current.severity === 'error') return sum + 12;
    if (current.severity === 'warning') return sum + 4;
    return sum;
  }, 0);
  const score = Math.max(0, 100 - penalty);
  return {
    score,
    passed: !issues.some((current) => current.severity === 'error') && score >= 80,
    deterministicIssues: issues,
    modelIssues: [],
    supportMatrix,
    remainingRisks: [],
    rounds: 0
  };
}

export function mergeModelAudit(
  base: PatentAudit,
  input: {
    issues?: AuditIssue[];
    supportMatrix?: PatentAudit['supportMatrix'];
    remainingRisks?: string[];
  }
) {
  const modelIssues = (input.issues || []).map((current, index) => {
    const raw = String(current.severity || '').trim().toLowerCase();
    let severity: AuditIssue['severity'] = 'warning';
    if (['error', 'err', 'p0', 'critical', 'fatal', 'high'].includes(raw)) severity = 'error';
    else if (['warning', 'warn', 'p1', 'medium'].includes(raw)) severity = 'warning';
    else if (['info', 'note', 'p2', 'low', 'fixed', 'resolved', 'ok', 'pass'].includes(raw)) severity = 'info';

    // 审校模型常把“已就地修好”的问题仍标成 error/warning，门禁会误杀。
    const changelog = `${current.message || ''} ${current.suggestion || ''}`;
    if (
      (severity === 'error' || severity === 'warning')
      && /已(?:修改|修复|更正|改正|修订|处理|补入|补充|加入|添加|完善|写明|改为|统一)|已在[^。；\n]{0,40}(?:补入|补充|加入|添加|修复|修改|更正|改正|修订|写明|定义)|无需修改|已确认全部已修复/.test(changelog)
    ) {
      severity = 'info';
    }

    return {
      ...current,
      id: current.id || `M-${index + 1}`,
      severity
    };
  });
  const modelSupport = new Map((input.supportMatrix || []).map((entry) => [entry.claim, entry.supported]));
  const deterministicIssues = base.deterministicIssues.filter((current) => {
    const claim = /^D-SUPPORT-(\d+)$/.exec(current.id)?.[1];
    return !claim || modelSupport.get(Number(claim)) !== true;
  });
  // 模型与确定性校验可能重复同一 id，按最高严重度保留一条。
  const rank = (severity: AuditIssue['severity']) =>
    severity === 'error' ? 3 : severity === 'warning' ? 2 : 1;
  const dedupeById = (issues: AuditIssue[]) => {
    const map = new Map<string, AuditIssue>();
    for (const item of issues) {
      const prev = map.get(item.id);
      if (!prev || rank(item.severity) > rank(prev.severity)) map.set(item.id, item);
    }
    return [...map.values()];
  };
  const uniqueModel = dedupeById(modelIssues);
  const modelIds = new Set(uniqueModel.map((item) => item.id));
  const uniqueDeterministic = dedupeById(deterministicIssues).filter(
    (item) => !modelIds.has(item.id)
  );
  const penaltyFor = (current: AuditIssue) =>
    current.severity === 'error' ? 12 : current.severity === 'warning' ? 3 : 0;
  const penalty = [...uniqueDeterministic, ...uniqueModel].reduce(
    (sum, current) => sum + penaltyFor(current),
    0
  );
  const score = Math.max(0, 100 - penalty);
  return {
    ...base,
    score,
    passed:
      !uniqueDeterministic.some((current) => current.severity === 'error')
      && !uniqueModel.some((current) => current.severity === 'error')
      && score >= 80,
    deterministicIssues: uniqueDeterministic,
    modelIssues: uniqueModel,
    supportMatrix: input.supportMatrix?.length ? input.supportMatrix : base.supportMatrix,
    remainingRisks: input.remainingRisks || [],
    rounds: base.rounds
  } satisfies PatentAudit;
}
