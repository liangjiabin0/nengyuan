const REQUIRED_FIELDS = [
  'guide_year',
  'cover_date',
  'guide_group',
  'project_name',
  'discipline_root_technology',
  'plan_alignment',
  'application_scenario',
  'functional_requirements',
  'key_technologies',
  'topics',
  'maturity_and_application',
  'duration',
  'budget_limit',
  'lead_unit'
] as const;

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('；');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return asText(
      record.text ?? record.value ?? record.title ?? record.need ?? record.name ?? record.problem
    );
  }
  return '';
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const text = asText(value);
  return text ? [text] : [];
}

function padResearchPoints(items: string[]): [string, string, string] {
  const next = items.filter(Boolean).slice(0, 3);
  const fillers = ['分析并建立对象模型与边界', '研究并提出核心方法与实现路径', '形成验证方案与可交付成果'];
  while (next.length < 3) next.push(fillers[next.length] || `形成第${next.length + 1}项方法`);
  return [next[0]!, next[1]!, next[2]!];
}

function currentCoverDate() {
  const now = new Date();
  return `${now.getFullYear()}年${now.getMonth() + 1}月`;
}

function topicFromNeed(raw: unknown, index: number) {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kpi = record.kpi && typeof record.kpi === 'object' ? (record.kpi as Record<string, unknown>) : {};
  const need = asText(record.need ?? record.title ?? raw) || `课题${index}`;
  return {
    title: need,
    problem: asText(record.problem) || need,
    research_points: padResearchPoints(asList(record.expected_goals ?? record.research_points)),
    interface: asText(record.interface),
    metrics: {
      performance:
        asText(asList(kpi.technical)[0] ?? kpi.performance ?? record.performance) ||
        '形成可验收方法，关键指标按场景标定',
      validation:
        asText(asList(kpi.validation)[0] ?? kpi.validation) || '在典型场景开展仿真或试验验证',
      outputs:
        asText(asList(kpi.deliverables)[0] ?? kpi.outputs ?? kpi.deliverable) ||
        '提交研究报告，申请发明专利1项'
    }
  };
}

export function coerceGuideJson(raw: unknown): Record<string, unknown> {
  const data =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};

  if (!Array.isArray(data.functional_requirements) && Array.isArray(data.functional_needs)) {
    const needs = data.functional_needs;
    data.functional_requirements = needs.map((item) => asText((item as { need?: unknown }).need ?? item));
    data.key_technologies = needs.map((item) => {
      const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return asList(record.key_technologies)[0] || asText(record.need) || '关键技术';
    });
    if (!Array.isArray(data.topics) || data.topics.length === 0) {
      data.topics = needs.map((item, index) => topicFromNeed(item, index + 1));
    }
  }

  if (Array.isArray(data.topics)) {
    data.topics = data.topics.map((item, index) => {
      const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const metrics =
        record.metrics && typeof record.metrics === 'object'
          ? (record.metrics as Record<string, unknown>)
          : {};
      const kpi = record.kpi && typeof record.kpi === 'object' ? (record.kpi as Record<string, unknown>) : {};
      return {
        title: asText(record.title) || `课题${index + 1}`,
        problem: asText(record.problem) || asText(record.title) || `课题${index + 1}问题`,
        research_points: padResearchPoints(asList(record.research_points ?? record.expected_goals)),
        interface: asText(record.interface),
        metrics: {
          performance:
            asText(metrics.performance ?? asList(kpi.technical)[0]) || '形成可验收方法，关键指标按场景标定',
          validation: asText(metrics.validation ?? asList(kpi.validation)[0]) || '在典型场景开展仿真或试验验证',
          outputs: asText(metrics.outputs ?? asList(kpi.deliverables)[0]) || '提交研究报告，申请发明专利1项'
        }
      };
    });
  }

  if (!data.guide_year) data.guide_year = new Date().getFullYear() + 1;
  if (!data.cover_date) data.cover_date = currentCoverDate();
  if (!data.guide_group) data.guide_group = '电网运行控制';
  if (!data.project_number) data.project_number = 1;
  if (!data.project_page) data.project_page = 2;
  if (!asText(data.discipline_root_technology)) {
    data.discipline_root_technology = '电气工程-电力系统及其自动化。';
  }
  if (!asText(data.plan_alignment)) data.plan_alignment = '建议新增（待赋号）。';
  if (!asText(data.application_scenario)) {
    data.application_scenario = asText(data.background) || asText(data.project_name);
  }
  if (!asText(data.maturity_and_application)) {
    data.maturity_and_application = '攻关前主要成果处于4级，攻关后达到6级，在相关场景试用。';
  }
  if (!asText(data.duration)) data.duration = '本项目研究起止时间待核定。';
  if (!asText(data.budget_limit)) data.budget_limit = '待核定。';
  if (!asText(data.lead_unit)) data.lead_unit = '待核定。';
  return data;
}

export function guideJsonMissingFields(data: Record<string, unknown>) {
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (data[field] == null || data[field] === '') missing.push(field);
  }
  const topics = Array.isArray(data.topics) ? data.topics : [];
  const requirements = Array.isArray(data.functional_requirements) ? data.functional_requirements : [];
  const technologies = Array.isArray(data.key_technologies) ? data.key_technologies : [];
  if (!topics.length) missing.push('topics');
  if (requirements.length !== topics.length) missing.push('functional_requirements 与课题数不一致');
  if (technologies.length !== topics.length) missing.push('key_technologies 与课题数不一致');
  return missing;
}
