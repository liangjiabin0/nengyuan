import type { Database } from './db';
import type { OutputInput, ProjectInput, RawRow } from './types';
import { resolveUpsertEdgeInDb, resolveUpsertEntityInDb } from './kg/entity-resolve';

const aliases: Record<string, string> = {
  '基金名': 'grantName',
  '基金名称': 'grantName',
  '基金项目': 'grantName',
  '基金类别': 'grantCategory',
  '资助类别': 'grantCategory',
  '重点专项/类别': 'grantCategory',
  '重点专项': 'grantCategory',
  '专项类别': 'grantCategory',
  '国家地区': 'country',
  '国家': 'country',
  '项目名(官方语言)': 'projectName',
  '项目名': 'projectName',
  '项目名称': 'projectName',
  '课题名称': 'projectName',
  '项目名(英语)': 'projectNameEn',
  '项目英文名': 'projectNameEn',
  '关键词(官方语言)': 'keywords',
  '关键词(英语)': 'keywordsEn',
  '关键词': 'keywords',
  '项目关键词': 'keywords',
  '命中检索词': 'keywords',
  '项目摘要(官方语言)': 'summary',
  '项目摘要(英语)': 'summaryEn',
  '项目摘要': 'summary',
  '摘要': 'summary',
  '摘要/检索片段': 'summary',
  '检索片段': 'summary',
  '立项编号': 'projectCode',
  '项目编号': 'projectCode',
  '批准号': 'projectCode',
  '课题编号': 'projectCode',
  '泛研网内部ID': 'projectCode',
  '内部ID': 'projectCode',
  '项目主持人': 'principalInvestigator',
  '主持人': 'principalInvestigator',
  '负责人': 'principalInvestigator',
  '项目负责人': 'principalInvestigator',
  'PI': 'principalInvestigator',
  '项目承担机构': 'institution',
  '承担机构': 'institution',
  '依托单位': 'institution',
  '申报单位': 'institution',
  '立项年度': 'year',
  '年度': 'year',
  '项目起始日期': 'startDate',
  '开始日期': 'startDate',
  '起始日期': 'startDate',
  '项目截止日期': 'endDate',
  '结束日期': 'endDate',
  '截止日期': 'endDate',
  '受资金额': 'amount',
  '资助金额': 'amount',
  '经费': 'amount',
  '货币单位': 'currency',
  '判定依据': 'judgmentBasis',
  '项目卡片原文': 'cardText',
  '来源URL': 'sourceUrl',
  '来源网址': 'sourceUrl',
  '参与者': 'participants',
  '参与人员': 'participants',
  '项目成员': 'participants',
  '课题组成员': 'participants',
  '源学科': 'discipline',
  '学科': 'discipline',
  '学科门类': 'discipline',
  '一级学科': 'discipline',
  '学科代码': 'disciplineCode',
  '参与机构': 'partnerInstitutions',
  '合作单位': 'partnerInstitutions',
  '合作机构': 'partnerInstitutions',
  '成果标题': 'outputTitle',
  '成果名称': 'outputTitle',
  '论文标题': 'outputTitle',
  '成果出版物': 'publication',
  '发表刊物': 'publication',
  '期刊': 'publication',
  '成果作者': 'authors',
  '作者': 'authors'
};

export function cleanValue(value: unknown) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function normalizeRow(row: RawRow) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const cleanKey = cleanValue(key).replace(/^﻿/, '');
    if (!cleanKey) continue;
    normalized[aliases[cleanKey] || cleanKey] = cleanValue(value);
  }
  return normalized;
}

export function hashText(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

export function entityKey(type: string, name: string) {
  return `${type}:${hashText(name.toLowerCase()).slice(0, 16)}`;
}

export function projectKey(row: Record<string, string>) {
  if (row.projectCode) return `project:${row.projectCode}`;
  const source = [row.projectName, row.principalInvestigator, row.institution, row.year].filter(Boolean).join('|');
  return `project:${hashText(source || JSON.stringify(row)).slice(0, 20)}`;
}

export function outputKey(project: string, row: Record<string, string>) {
  return `output:${hashText([project, row.outputTitle, row.publication, row.authors].join('|')).slice(0, 24)}`;
}

export function toProjectInput(row: Record<string, string>): ProjectInput {
  return {
    projectKey: projectKey(row),
    grantName: row.grantName,
    grantCategory: row.grantCategory,
    country: row.country,
    projectName: row.projectName,
    projectNameEn: row.projectNameEn,
    keywords: row.keywords || row.keywordsEn,
    summary: row.summary || row.summaryEn,
    projectCode: row.projectCode,
    principalInvestigator: row.principalInvestigator,
    institution: row.institution,
    year: row.year,
    startDate: row.startDate,
    endDate: row.endDate,
    amount: row.amount,
    currency: row.currency,
    participants: row.participants,
    discipline: row.discipline,
    disciplineCode: row.disciplineCode,
    partnerInstitutions: row.partnerInstitutions
  };
}

export function toOutputInput(project: string, row: Record<string, string>): OutputInput | null {
  if (!row.outputTitle) return null;
  return {
    outputKey: outputKey(project, row),
    projectKey: project,
    title: row.outputTitle,
    publication: row.publication,
    authors: row.authors
  };
}

export async function upsertEntityInDb(db: Database, type: string, name?: string, meta: Record<string, unknown> = {}) {
  return await resolveUpsertEntityInDb(db, type, name, meta);
}

export async function upsertEdgeInDb(db: Database, source: string | null, target: string | null, relation: string, weight = 1, meta: Record<string, unknown> = {}) {
  await resolveUpsertEdgeInDb(db, source, target, relation, weight, meta);
}

export async function upsertEntity(type: string, name?: string, meta: Record<string, unknown> = {}) {
  const { withTransaction } = await import('./db');
  let key: string | null = null;
  await withTransaction(async (db) => {
    key = await resolveUpsertEntityInDb(db, type, name, meta);
  }, true);
  return key;
}

export async function upsertEdge(source: string | null, target: string | null, relation: string, weight = 1, meta: Record<string, unknown> = {}) {
  const { withTransaction } = await import('./db');
  await withTransaction(async (db) => {
    await resolveUpsertEdgeInDb(db, source, target, relation, weight, meta);
  }, true);
}

export function splitList(value?: string) {
  return cleanValue(value)
    .split(/[;；,，、|/｜]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 30);
}

export async function upsertProjectEntitiesInDb(db: Database, project: ProjectInput) {
  const projectEntity = await upsertEntityInDb(db, 'project', project.projectName || project.projectNameEn || project.projectKey, { projectKey: project.projectKey });
  await upsertEdgeInDb(db, project.projectKey, projectEntity, 'entity');
  await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'fund', project.grantName), 'belongs_to_fund');
  await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'institution', project.institution), 'undertaken_by');
  await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'person', project.principalInvestigator), 'hosted_by');
  await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'country', project.country), 'located_in');
  await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'discipline', project.discipline), 'in_discipline');

  for (const keyword of splitList(project.keywords)) {
    await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'keyword', keyword), 'has_keyword');
  }
  for (const partner of splitList(project.partnerInstitutions)) {
    await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'institution', partner), 'partnered_with');
  }
  for (const participant of splitList(project.participants)) {
    await upsertEdgeInDb(db, project.projectKey, await upsertEntityInDb(db, 'person', participant), 'participates_in', 2);
  }
}

export async function upsertOutputEntitiesInDb(db: Database, output: OutputInput) {
  const outputEntity = await upsertEntityInDb(db, 'output', output.title, { outputKey: output.outputKey });
  await upsertEdgeInDb(db, output.projectKey, output.outputKey, 'produces');
  await upsertEdgeInDb(db, output.outputKey, outputEntity, 'entity');
  await upsertEdgeInDb(db, output.outputKey, await upsertEntityInDb(db, 'publication', output.publication), 'published_in');

  for (const author of splitList(output.authors)) {
    await upsertEdgeInDb(db, output.outputKey, await upsertEntityInDb(db, 'person', author), 'authored_by');
  }
}

export async function upsertProjectEntities(project: ProjectInput) {
  const { withTransaction } = await import('./db');
  await withTransaction(async (db) => await upsertProjectEntitiesInDb(db, project), true);
}

export async function upsertOutputEntities(output: OutputInput) {
  const { withTransaction } = await import('./db');
  await withTransaction(async (db) => await upsertOutputEntitiesInDb(db, output), true);
}
