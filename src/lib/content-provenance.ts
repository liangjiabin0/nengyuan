/** 证据出处标注，避免 AI 把参考文献/摘要当成正文 */

export type ContentKind =
  | 'paper_body'
  | 'paper_body_full'
  | 'paper_abstract'
  | 'paper_reference'
  | 'paper_bio'
  | 'paper_appendix'
  | 'patent_document'
  | 'mentor_profile'
  | 'project_record'
  | 'student_bio'
  | 'graph_edge'
  | 'analytics'
  | 'user_attachment'
  | 'unknown';

export function contentKindLabel(kind: ContentKind) {
  const map: Record<ContentKind, string> = {
    paper_body: '论文正文片段',
    paper_body_full: '论文正文全文',
    paper_abstract: '论文摘要',
    paper_reference: '参考文献条目',
    paper_bio: '作者简介',
    paper_appendix: '附录',
    patent_document: '专利全文',
    mentor_profile: '导师档案',
    project_record: '科研项目',
    student_bio: '学生/作者简介',
    graph_edge: '图谱关系',
    analytics: '统计结果',
    user_attachment: '用户上传附件',
    unknown: '未分类'
  };
  return map[kind] || kind;
}

export function inferContentKind(result: {
  sourceType: string;
  fields?: Record<string, unknown>;
}): ContentKind {
  const fields = result.fields || {};
  const section = String(fields.section || fields.parent_section || '');
  const role = String(fields.chunk_role || fields.chunkRole || '');

  if (result.sourceType === 'paper_reference') return 'paper_reference';
  if (result.sourceType === 'mentor') return 'mentor_profile';
  if (result.sourceType === 'project') return 'project_record';
  if (result.sourceType === 'attachment' || result.sourceType === 'attachment_chunk') {
    return 'user_attachment';
  }
  if (fields.contentKind === 'paper_body_full') return 'paper_body_full';

  if (
    result.sourceType === 'patent'
    || result.sourceType === 'patent_chunk'
    || fields.docKind === 'patent'
    || section === '专利全文'
  ) {
    return 'patent_document';
  }

  if (
    result.sourceType === 'paper_chunk'
    && /硕士研究生|硕士生/.test(String(fields.text || fields.child_text || ''))
  ) {
    return 'student_bio';
  }

  if (result.sourceType === 'paper_chunk' || result.sourceType === 'paper') {
    if (role === 'reference' || section === '参考文献') return 'paper_reference';
    if (/参考文献|References/i.test(section)) return 'paper_reference';
    if (/摘要|Abstract/i.test(section)) return 'paper_abstract';
    if (/作者简介|收稿日期/i.test(section) || /作者简介|收稿日期/.test(String(fields.text || ''))) return 'paper_bio';
    if (/附录|Appendix/i.test(section)) return 'paper_appendix';
    if (result.sourceType === 'paper' && fields.abstract) return 'paper_abstract';
    return 'paper_body';
  }

  return 'unknown';
}

export function provenanceHeader(kind: ContentKind) {
  const label = contentKindLabel(kind);
  if (kind === 'paper_reference') return `【出处: ${label} · 非正文 · 不可当作正文结论】`;
  if (kind === 'paper_abstract') return `【出处: ${label} · 非正文细节】`;
  if (kind === 'paper_bio' || kind === 'student_bio') return `【出处: ${label} · 人物信息非论述正文】`;
  if (kind === 'patent_document') return `【出处: ${label} · 专利】`;
  if (kind === 'paper_body' || kind === 'paper_body_full') return `【出处: ${label}】`;
  if (kind === 'mentor_profile') return `【出处: ${label} · 导师档案】`;
  if (kind === 'project_record') return `【出处: ${label}】`;
  if (kind === 'user_attachment') return `【出处: ${label} · 当前会话材料 · 非全局知识库】`;
  return `【出处: ${label}】`;
}

export function stampResult<T extends { sourceType: string; fields?: Record<string, unknown>; matchReason?: string }>(
  result: T,
  kind?: ContentKind
): T & { fields: Record<string, unknown> } {
  const contentKind = kind || inferContentKind(result);
  return {
    ...result,
    fields: {
      ...(result.fields || {}),
      contentKind,
      contentKindLabel: contentKindLabel(contentKind)
    },
    matchReason: result.matchReason || contentKindLabel(contentKind)
  };
}
