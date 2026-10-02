'use client';

import Link from 'next/link';
import {
  Check,
  ChevronRight,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { notify } from '@/lib/notify';
import { canDeleteSharedSkill } from '@/lib/skill-permissions';
import {
  CHAT_COMPOSER_TOOLS,
  findComposerTool,
  type ComposerToolId
} from '@/lib/chat-composer-tools';

type SharedSkill = {
  id: string;
  name: string;
  title: string;
  description: string;
  uploadedBy?: string | null;
  source?: 'shared' | 'system';
  canDelete?: boolean;
};

type SkillSourceFilter = 'all' | 'mine' | 'system';

const SKILL_SOURCE_FILTERS: Array<{ id: SkillSourceFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'mine', label: '自己上传' },
  { id: 'system', label: '系统' }
];

function skillMatchesSource(
  skill: Pick<SharedSkill, 'source' | 'uploadedBy'>,
  filter: SkillSourceFilter,
  userId?: string | null
) {
  if (filter === 'system') return skill.source === 'system';
  if (filter === 'mine') return skill.source !== 'system' && Boolean(userId) && skill.uploadedBy === userId;
  return true;
}

function skillMatchesQuery(skill: Pick<SharedSkill, 'name' | 'title' | 'description'>, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    skill.title.toLowerCase().includes(q)
    || skill.name.toLowerCase().includes(q)
    || skill.description.toLowerCase().includes(q)
  );
}

export function ComposerToolChip({
  tool,
  onClear
}: {
  tool: ComposerToolId;
  onClear: () => void;
}) {
  const selected = findComposerTool(tool);
  if (!selected) return null;
  const Icon = selected.icon;
  return (
    <span className="inline-flex h-9 max-w-[14rem] items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 pl-2.5 pr-1.5 text-sm font-medium text-primary">
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{selected.label}</span>
      <button
        type="button"
        onClick={onClear}
        className="flex h-6 w-6 items-center justify-center rounded-full text-primary/70 transition hover:bg-primary/15 hover:text-primary"
        aria-label={`取消${selected.label}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

export function ChatComposerToolMenu({
  selectedTool,
  onSelect
}: {
  selectedTool: ComposerToolId | null;
  onSelect: (tool: ComposerToolId) => void;
}) {
  const { user, isAdmin } = useAuth();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [skillSubmenuOpen, setSkillSubmenuOpen] = useState(false);
  const [skillMenuQuery, setSkillMenuQuery] = useState('');
  const [skillMenuSource, setSkillMenuSource] = useState<SkillSourceFilter>('all');
  const [sharedSkills, setSharedSkills] = useState<SharedSkill[]>([]);

  function refreshSharedSkills() {
    return fetch('/api/skills')
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { skills?: SharedSkill[] };
        if (!response.ok) return;
        setSharedSkills(Array.isArray(payload.skills) ? payload.skills : []);
      })
      .catch(() => undefined);
  }

  async function deleteOwnSkill(skill: SharedSkill) {
    const allowed = canDeleteSharedSkill(skill, {
      id: user?.id,
      role: isAdmin ? 'admin' : user?.role
    });
    if (!allowed) return;
    const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(payload.error || '删除失败');
    setSharedSkills((current) => current.filter((item) => item.id !== skill.id));
  }

  useEffect(() => {
    if (!open) {
      setSkillSubmenuOpen(false);
      setSkillMenuQuery('');
      setSkillMenuSource('all');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function eventInsideMenu(event: Event) {
      const root = rootRef.current;
      if (!root) return false;
      return event.composedPath().includes(root);
    }
    function dismiss() {
      setOpen(false);
      setSkillSubmenuOpen(false);
    }
    function onPointerDown(event: PointerEvent) {
      if (!eventInsideMenu(event)) dismiss();
    }
    function onFocusIn(event: FocusEvent) {
      if (!eventInsideMenu(event)) dismiss();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (skillSubmenuOpen) {
        setSkillSubmenuOpen(false);
        return;
      }
      dismiss();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, skillSubmenuOpen]);

  const visibleSharedSkills = useMemo(() => {
    return sharedSkills.filter((skill) => (
      skillMatchesSource(skill, skillMenuSource, user?.id)
      && skillMatchesQuery(skill, skillMenuQuery)
    ));
  }, [sharedSkills, skillMenuQuery, skillMenuSource, user?.id]);

  return (
    <div ref={rootRef} className="relative flex h-8 w-8 shrink-0 items-center justify-center">
      {open ? (
        <div
          className="rag-composer-tool-menu"
          aria-label="对话功能"
          onMouseLeave={() => setSkillSubmenuOpen(false)}
        >
          {skillSubmenuOpen ? (
            <div className="rag-composer-skill-menu" role="menu" aria-label="技能列表">
              <div className="rag-composer-skill-menu-panel">
                <div className="rag-composer-skill-menu-toolbar">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={skillMenuQuery}
                      onChange={(event) => setSkillMenuQuery(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Escape' && skillMenuQuery) {
                          event.preventDefault();
                          setSkillMenuQuery('');
                        }
                      }}
                      placeholder="搜索技能"
                      className="h-10 w-full rounded-none border-0 bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-0"
                      aria-label="搜索技能"
                    />
                  </div>
                  <div className="flex items-center gap-1 px-2 py-1.5" role="tablist" aria-label="技能来源">
                    {SKILL_SOURCE_FILTERS.map((item) => {
                      const active = skillMenuSource === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setSkillMenuSource(item.id)}
                          className={`rounded-md px-2 py-1 text-xs transition ${
                            active
                              ? 'bg-accent font-medium text-foreground'
                              : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                          }`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="rag-composer-skill-menu-list">
                  {sharedSkills.length ? (
                    visibleSharedSkills.length ? (
                      <div className="space-y-px" role="group">
                        {visibleSharedSkills.map((skill) => {
                          const mine = Boolean(user?.id) && skill.uploadedBy === user?.id;
                          const canDelete = canDeleteSharedSkill(skill, {
                            id: user?.id,
                            role: isAdmin ? 'admin' : user?.role
                          });
                          return (
                            <div
                              key={skill.id}
                              className="flex h-10 items-center gap-2.5 rounded-xl px-2.5 text-left text-foreground transition hover:bg-accent/70"
                            >
                              <span className="min-w-0 flex-1 truncate text-[15px]">{skill.title || skill.name}</span>
                              {skill.source === 'system' ? (
                                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                  系统
                                </span>
                              ) : (
                                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                  {mine ? '自己' : '共享'}
                                </span>
                              )}
                              {canDelete ? (
                                <button
                                  type="button"
                                  aria-label={`删除 ${skill.title || skill.name}`}
                                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (!window.confirm(`删除「${skill.title || skill.name}」？`)) return;
                                    void deleteOwnSkill(skill).catch((error) => {
                                      notify.error(error instanceof Error ? error.message : '删除失败');
                                    });
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="px-2.5 py-2 text-sm text-muted-foreground">
                        没有匹配的技能。
                      </p>
                    )
                  ) : (
                    <p className="px-2.5 py-2 text-sm text-muted-foreground">
                      还没有技能。
                    </p>
                  )}
                  <Link
                    href="/skills"
                    className="mt-0.5 flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  >
                    <Sparkles className="h-4 w-4" />
                    管理技能库
                  </Link>
                </div>
              </div>
            </div>
          ) : null}
          <div role="radiogroup" aria-label="对话功能">
            {CHAT_COMPOSER_TOOLS.map((tool) => {
              const checked = selectedTool === tool.id;
              const ToolIcon = tool.icon;
              return (
                <button
                  key={tool.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => {
                    onSelect(tool.id);
                    setOpen(false);
                    setSkillSubmenuOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2.5 text-left transition ${
                    checked
                      ? 'bg-accent text-foreground'
                      : 'text-foreground hover:bg-accent/70'
                  }`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ToolIcon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{tool.label}</span>
                  <Check className={`h-4 w-4 shrink-0 ${checked ? 'opacity-100' : 'opacity-0'}`} />
                </button>
              );
            })}
          </div>
          <div className="mx-1 my-1 border-t border-border" />
          <div
            onMouseEnter={() => {
              setSkillSubmenuOpen(true);
              void refreshSharedSkills();
            }}
          >
            <button
              type="button"
              onClick={() => {
                setSkillSubmenuOpen(true);
                void refreshSharedSkills();
              }}
              className={`flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2.5 text-left transition ${
                skillSubmenuOpen
                  ? 'bg-accent text-foreground'
                  : 'text-foreground hover:bg-accent/70'
              }`}
              aria-expanded={skillSubmenuOpen}
              aria-haspopup="menu"
              aria-label="技能"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Sparkles className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">技能</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setOpen((current) => {
            const next = !current;
            if (next) void refreshSharedSkills();
            return next;
          });
        }}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
          open
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        }`}
        aria-label={open ? '收起功能列表' : '打开功能列表'}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="功能"
      >
        <Plus className={`h-5 w-5 transition-transform duration-200 ${open ? 'rotate-45' : ''}`} />
      </button>
    </div>
  );
}
