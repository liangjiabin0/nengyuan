'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

type Proposal = {
  id: string;
  target: 'private_memory' | 'skill_memory_rule';
  scope: 'private' | 'shared';
  title: string;
  rationale: string;
  diff: string;
  proposalHash: string;
  status: string;
  baseVersion: string | null;
};

const STATUS: Record<string, string> = { pending: '待确认', approved: '已写入', rejected: '已拒绝', conflict: '冲突未写入', rolled_back: '已回滚' };
const TARGET: Record<string, string> = { private_memory: '我的自学习记忆（仅自己）', skill_memory_rule: '共享评审记忆规则 paper-peer-review v8（需管理员）' };

/** 经验候选：默认不写入；用户勾选后在确认弹窗里看完整 diff，再由服务端校验身份与候选 hash 后写入。 */
export function PaperReviewProposals({ taskId, canGenerate }: { taskId: string; canGenerate: boolean }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/paper-review/${taskId}/proposals`, { cache: 'no-store' });
    const data = (await res.json().catch(() => ({}))) as { proposals?: Proposal[]; isAdmin?: boolean };
    setProposals(data.proposals || []);
    setIsAdmin(Boolean(data.isAdmin));
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/paper-review/${taskId}/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error || '操作失败');
    return data;
  }

  async function generate() {
    setBusy(true);
    try {
      await post({ action: 'generate' });
      await load();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
    }
  }

  async function approveSelected() {
    setBusy(true);
    const results: string[] = [];
    for (const p of proposals.filter((x) => checked.has(x.id))) {
      try {
        await post({ action: 'approve', proposalId: p.id, proposalHash: p.proposalHash });
        results.push(`已写入：${p.title}`);
      } catch (e) {
        results.push(`未写入：${p.title}（${e instanceof Error ? e.message : '失败'}）`);
      }
    }
    setBusy(false);
    setConfirming(false);
    setChecked(new Set());
    notify.success(results.join('\n'));
    await load();
  }

  const pending = proposals.filter((p) => p.status === 'pending');
  const selected = proposals.filter((p) => checked.has(p.id));
  const blocked = selected.some((p) => p.scope === 'shared') && !isAdmin;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <p className="text-xs leading-5 text-muted-foreground">
          这里列出本次评审中经过核实、可在以后的评审里复用的经验建议。<b className="text-foreground">默认不会写入任何地方</b>：只有你勾选并在确认框里点“确认写入”后才生效。共享技能规则需要管理员，写入前会自动备份，可回滚；可执行脚本不在可写范围内。
        </p>
        {canGenerate ? (
          <button type="button" className="ui-btn-secondary h-8 gap-1.5 px-3 text-xs" disabled={busy} onClick={() => void generate()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}生成经验候选
          </button>
        ) : <p className="text-xs text-muted-foreground">评审报告生成后才能提出经验候选。</p>}
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.id} className="rounded-md border border-border p-3 text-xs">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" disabled={p.status !== 'pending'} checked={checked.has(p.id)}
                  onChange={(e) => setChecked((cur) => { const n = new Set(cur); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{p.title}</span>
                  <span className={cn('ml-2 rounded px-1.5 py-px text-[10px]', p.status === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-muted text-muted-foreground')}>{STATUS[p.status] || p.status}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">写入目标：{TARGET[p.target]}</span>
                  <span className="mt-1 block text-[11px] text-foreground/80">{p.rationale}</span>
                </span>
              </label>
              {p.status === 'approved' && p.target === 'skill_memory_rule' && isAdmin ? (
                <button type="button" className="mt-2 text-[11px] text-muted-foreground underline" disabled={busy}
                  onClick={() => void post({ action: 'rollback', proposalId: p.id }).then(load).catch((e) => notify.error(e.message))}>回滚这条规则</button>
              ) : null}
            </li>
          ))}
        </ul>
        {pending.length ? (
          <div className="flex justify-end gap-2">
            <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" disabled={busy || !selected.length}
              onClick={() => void Promise.all(selected.map((p) => post({ action: 'reject', proposalId: p.id }))).then(load).then(() => setChecked(new Set())).catch((e) => notify.error(e.message))}>拒绝所选</button>
            <button type="button" className="ui-btn-primary h-8 px-3 text-xs" disabled={busy || !selected.length} onClick={() => setConfirming(true)}>查看差异并确认…</button>
          </div>
        ) : null}
      </div>

      {confirming ? (
        <div className="rag-evidence-modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="rag-evidence-modal max-w-2xl" role="dialog" aria-modal="true" aria-label="确认写入经验" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">确认写入 {selected.length} 条经验</h3>
                <p className="mt-1 text-sm text-muted-foreground">请逐条核对下面的完整改动。写入后对以后的评审生效；已在运行的任务不受影响。</p>
              </div>
              <button type="button" onClick={() => setConfirming(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label="关闭"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto px-5 py-4">
              {selected.map((p) => (
                <div key={p.id} className="space-y-1">
                  <div className="text-xs font-medium text-foreground">{p.title} → {TARGET[p.target]}</div>
                  {p.scope === 'shared' ? <div className="text-[11px] text-muted-foreground">影响范围：所有用户以后的论文评审；基线版本 {p.baseVersion?.slice(0, 12)}；写入前自动备份</div> : <div className="text-[11px] text-muted-foreground">影响范围：仅你自己的对话与评审</div>}
                  <pre className="scrollbar-thin max-h-60 overflow-auto rounded border border-border bg-muted/40 p-2 text-[11px] leading-5">{p.diff}</pre>
                </div>
              ))}
              {blocked ? <p className="text-xs text-rose-700">所选内容包含共享技能规则，需要管理员才能写入。</p> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <button type="button" className="ui-btn-secondary h-9" onClick={() => setConfirming(false)} disabled={busy}>取消</button>
              <button type="button" className="ui-btn-primary h-9" onClick={() => void approveSelected()} disabled={busy || blocked}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}确认写入
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
