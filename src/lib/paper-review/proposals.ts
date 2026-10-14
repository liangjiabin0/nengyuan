import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run } from '../db';
import { saveUserLearningMemories } from '../self-learning';
import { callPaperReviewModel, probePaperReviewModel, resolvePaperReviewEndpoint } from './llm';
import { getPaperReviewModelConfig } from './model-config';
import { REVIEW_SKILL_DIR, inspectSkillSnapshot, skillRoot } from './skills';
import { getPaperReviewTask } from './store';
import { readJson, taskDir, writeFileAtomic } from './workspace';

/**
 * 经验 / Skill 更新候选。流程：生成候选 → 页面展示 diff → 用户勾选并确认 → 服务端鉴权 → 备份 → 原子写入 → 版本记录 → 可回滚。
 * 默认不写入任何东西。目标分两类：
 *  - private_memory：写入当前用户的自学习记忆（普通用户可确认，只影响自己）；
 *  - skill_memory_rule：追加到共享技能 paper-peer-review-v8 的 power-system-review-memory.md（必须管理员）。
 * 可执行脚本不在可写目标之列：模型、论文或技能内容都不能借此改写任何代码。
 */
export type ProposalTarget = 'private_memory' | 'skill_memory_rule';

export type Proposal = {
  id: string;
  taskId: string;
  userId: string;
  target: ProposalTarget;
  scope: 'private' | 'shared';
  title: string;
  rationale: string;
  diff: string;
  payload: Record<string, unknown>;
  baseVersion: string | null;
  proposalHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'conflict' | 'rolled_back';
  decidedBy: string | null;
  decidedAt: string | null;
  backupPath: string | null;
  createdAt: string;
};

type Row = {
  id: string; task_id: string; user_id: string; target: ProposalTarget; scope: 'private' | 'shared'; title: string; rationale: string; diff: string;
  payload_json: string; base_version: string | null; proposal_hash: string; status: Proposal['status']; decided_by: string | null; decided_at: string | null;
  backup_path: string | null; created_at: string;
};

const map = (r: Row): Proposal => ({
  id: r.id, taskId: r.task_id, userId: r.user_id, target: r.target, scope: r.scope, title: r.title, rationale: r.rationale, diff: r.diff,
  payload: JSON.parse(r.payload_json || '{}'), baseVersion: r.base_version, proposalHash: r.proposal_hash, status: r.status,
  decidedBy: r.decided_by, decidedAt: r.decided_at, backupPath: r.backup_path, createdAt: r.created_at
});

const MEMORY_FILE = () => path.join(skillRoot(REVIEW_SKILL_DIR), 'references', 'power-system-review-memory.md');
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

export async function listProposals(taskId: string) {
  return (await all<Row>('SELECT * FROM paper_review_proposals WHERE task_id = ? ORDER BY created_at ASC', [taskId])).map(map);
}

/** 基于本次已核实的评审结果，让模型提出可复用的经验候选。只生成，不写入。 */
export async function generateProposals(taskId: string) {
  const task = await getPaperReviewTask(taskId);
  if (!task) throw new Error('任务不存在');
  const root = taskDir(taskId);
  const record = readJson<Record<string, unknown>>(path.join(root, 'review', 'review.json'), {});
  if (!record.metadata) throw new Error('评审报告尚未生成，无法提出经验候选');
  const verdict = readJson(path.join(root, 'work', 'repro-verdict.json'), {});
  const memory = fs.readFileSync(MEMORY_FILE(), 'utf8');
  const ruleIds = [...memory.matchAll(/^### (M\d{2})\b/gm)].map((m) => m[1]);
  const endpoint = resolvePaperReviewEndpoint(await probePaperReviewModel(), { allowStormFallback: task.options.allowStormFallback || getPaperReviewModelConfig().allowStormFallback });
  const { text } = await callPaperReviewModel(endpoint, [
    { role: 'system', content: '你是评审记忆维护者。只提出经本次评审真实核实、可跨论文复用的通用经验；不得包含某篇论文的私人信息、未经核实的批评或个别特例。输出合法 JSON。' },
    { role: 'user', content: `现有记忆规则编号：${ruleIds.join(', ')}\n现有记忆（节选）：\n${memory.slice(0, 20_000)}\n\n本次评审的已核实问题与知识应用：<tool_output>${JSON.stringify({ issues: record.issues, knowledge_application: record.knowledge_application, reproduction: record.reproduction, verdict }).slice(0, 60_000)}</tool_output>\n\n提出 0–3 条候选。已有规则能覆盖的不要重复。每条给出：触发条件、验证步骤、退出准则。输出 JSON：{"proposals":[{"target":"private_memory|skill_memory_rule","title":"","rationale":"为什么这是可复用经验，依据本次哪条已核实证据","rule_markdown":"若 target=skill_memory_rule：完整的新规则段落，以 '### M<下一个编号> 标题' 开头","memory":{"instruction":"若 target=private_memory：一句可执行的经验","applicability":"","operation":""}}]}` }
  ], { stage: 'skill_proposals', json: true, maxTokens: 12_000 });
  const parsed = JSON.parse(text) as { proposals?: Array<{ target: ProposalTarget; title: string; rationale: string; rule_markdown?: string; memory?: Record<string, string> }> };
  const baseVersion = sha(memory);
  const created: Proposal[] = [];
  const nextNo = Math.max(0, ...ruleIds.map((r) => Number(r.slice(1)))) + 1;
  for (const [i, p] of (parsed.proposals || []).slice(0, 3).entries()) {
    const target: ProposalTarget = p.target === 'skill_memory_rule' ? 'skill_memory_rule' : 'private_memory';
    let diff = '';
    let payload: Record<string, unknown> = {};
    if (target === 'skill_memory_rule') {
      const ruleId = `M${String(nextNo + i).padStart(2, '0')}`;
      const body = String(p.rule_markdown || '').replace(/^###\s+M\d{2}\b/, `### ${ruleId}`).trim();
      if (!body.startsWith(`### ${ruleId}`)) continue;
      payload = { ruleId, markdown: body };
      diff = `--- references/power-system-review-memory.md\n+++ references/power-system-review-memory.md\n@@ 末尾追加 @@\n${body.split('\n').map((l) => `+${l}`).join('\n')}`;
    } else {
      const m = p.memory || {};
      if (!m.instruction) continue;
      payload = { instruction: m.instruction, applicability: m.applicability || '', operation: m.operation || '' };
      diff = `+ 私有自学习记忆（论文评审）：${m.instruction}${m.applicability ? `\n+ 适用：${m.applicability}` : ''}${m.operation ? `\n+ 做法：${m.operation}` : ''}`;
    }
    const id = crypto.randomUUID();
    const proposalHash = sha(JSON.stringify({ id, target, payload, baseVersion }));
    await run(
      `INSERT INTO paper_review_proposals (id, task_id, user_id, target, scope, title, rationale, diff, payload_json, base_version, proposal_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, taskId, task.userId, target, target === 'skill_memory_rule' ? 'shared' : 'private', String(p.title || '').slice(0, 200), String(p.rationale || '').slice(0, 2000), diff, JSON.stringify(payload), target === 'skill_memory_rule' ? baseVersion : null, proposalHash, new Date().toISOString()]
    );
    created.push((await getProposal(id))!);
  }
  return created;
}

export async function getProposal(id: string) {
  const row = await get<Row>('SELECT * FROM paper_review_proposals WHERE id = ?', [id]);
  return row ? map(row) : null;
}

/**
 * 确认写入。必须提供提案 hash（防止页面显示的和实际写入的不一致）。
 * 共享规则：需要管理员；基线版本不一致（期间别人改过）时拒绝覆盖并标记冲突。
 */
export async function approveProposal(id: string, user: { id: string; username: string; isAdmin: boolean }, proposalHash: string) {
  const p = await getProposal(id);
  if (!p) throw new Error('候选不存在');
  if (p.status !== 'pending') throw new Error(`该候选已处理（${p.status}）`);
  if (p.proposalHash !== proposalHash) throw new Error('候选内容与确认时看到的不一致，请刷新后重新确认');
  if (p.userId !== user.id && !user.isAdmin) throw new Error('无权确认该候选');
  const now = new Date().toISOString();
  if (p.target === 'private_memory') {
    await saveUserLearningMemories({
      userId: p.userId,
      conversationId: `paper-review:${p.taskId}`,
      learning: {
        domainKey: 'paper-review',
        domainLabel: '论文评审',
        memories: [{
          kind: 'workflow',
          instruction: String(p.payload.instruction).slice(0, 500),
          operation: String(p.payload.operation || '').slice(0, 500),
          applicability: String(p.payload.applicability || '').slice(0, 300),
          keywords: ['论文评审'],
          confidence: 0.7
        }]
      }
    });
    await run(`UPDATE paper_review_proposals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`, [user.id, now, id]);
    return { ok: true, target: p.target };
  }
  if (!user.isAdmin) throw new Error('修改共享技能需要管理员权限');
  const file = MEMORY_FILE();
  const current = fs.readFileSync(file, 'utf8');
  if (sha(current) !== p.baseVersion) {
    await run(`UPDATE paper_review_proposals SET status = 'conflict', decided_by = ?, decided_at = ? WHERE id = ?`, [user.id, now, id]);
    throw new Error('共享记忆在候选生成之后已被修改，为避免覆盖已拒绝写入（已标记冲突）。请重新生成候选。');
  }
  const ruleId = String(p.payload.ruleId);
  if (new RegExp(`^### ${ruleId}\\b`, 'm').test(current)) throw new Error(`规则编号 ${ruleId} 已存在`);
  const backupDir = path.join(process.cwd(), 'storage', 'paper-review', 'skill-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `power-system-review-memory.${Date.now()}.md`);
  fs.copyFileSync(file, backupPath);
  const next = `${current.replace(/\s*$/, '')}\n\n${String(p.payload.markdown)}\n`;
  writeFileAtomic(file, next);
  // 更新快照记录，使技能完整性检查认可这次经确认的修改
  const snapPath = path.join(skillRoot(REVIEW_SKILL_DIR), 'skill-snapshot.json');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as { files: Array<{ path: string; sha256: string; bytes: number }>; history?: unknown[]; contentSha256: string };
  const entry = snap.files.find((f) => f.path === 'references/power-system-review-memory.md');
  if (entry) { entry.sha256 = sha(next); entry.bytes = Buffer.byteLength(next); }
  snap.history = [...(snap.history || []), { at: now, by: user.username, proposalId: id, change: `追加 ${ruleId}`, backup: path.basename(backupPath) }];
  snap.contentSha256 = sha(JSON.stringify(snap.files));
  writeFileAtomic(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
  if (!inspectSkillSnapshot(REVIEW_SKILL_DIR).intact) {
    fs.copyFileSync(backupPath, file);
    throw new Error('写入后技能完整性校验失败，已自动恢复备份');
  }
  await run(`UPDATE paper_review_proposals SET status = 'approved', decided_by = ?, decided_at = ?, backup_path = ? WHERE id = ?`, [user.id, now, path.basename(backupPath), id]);
  return { ok: true, target: p.target, ruleId };
}

export async function rejectProposal(id: string, user: { id: string; isAdmin: boolean }) {
  const p = await getProposal(id);
  if (!p) throw new Error('候选不存在');
  if (p.userId !== user.id && !user.isAdmin) throw new Error('无权处理该候选');
  if (p.status !== 'pending') throw new Error('该候选已处理');
  await run(`UPDATE paper_review_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`, [user.id, new Date().toISOString(), id]);
}

/** 回滚一条已写入的共享规则：恢复写入前的备份（仅管理员，且要求之后没有别的写入）。 */
export async function rollbackProposal(id: string, user: { id: string; username: string; isAdmin: boolean }) {
  if (!user.isAdmin) throw new Error('回滚共享技能需要管理员权限');
  const p = await getProposal(id);
  if (!p || p.status !== 'approved' || p.target !== 'skill_memory_rule' || !p.backupPath) throw new Error('该候选不能回滚');
  const later = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM paper_review_proposals WHERE target = 'skill_memory_rule' AND status = 'approved' AND decided_at > ?`, [p.decidedAt]);
  if (Number(later?.n || 0) > 0) throw new Error('之后还有其它已写入的共享规则，请按相反顺序逐条回滚');
  const backup = path.join(process.cwd(), 'storage', 'paper-review', 'skill-backups', path.basename(p.backupPath));
  if (!fs.existsSync(backup)) throw new Error('备份文件不存在');
  const restored = fs.readFileSync(backup);
  writeFileAtomic(MEMORY_FILE(), restored);
  const snapPath = path.join(skillRoot(REVIEW_SKILL_DIR), 'skill-snapshot.json');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as { files: Array<{ path: string; sha256: string; bytes: number }>; history?: unknown[]; contentSha256: string };
  const entry = snap.files.find((f) => f.path === 'references/power-system-review-memory.md');
  if (entry) { entry.sha256 = sha(restored); entry.bytes = restored.length; }
  snap.history = [...(snap.history || []), { at: new Date().toISOString(), by: user.username, proposalId: id, change: `回滚 ${String(p.payload.ruleId)}` }];
  snap.contentSha256 = sha(JSON.stringify(snap.files));
  writeFileAtomic(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
  await run(`UPDATE paper_review_proposals SET status = 'rolled_back', decided_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
}
