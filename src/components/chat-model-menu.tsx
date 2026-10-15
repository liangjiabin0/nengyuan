'use client';

import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { createPortal } from 'react-dom';
import { CHAT_MODEL_IDS, CHAT_MODEL_META, type ChatModelId } from '@/lib/model-ids';
import {
  defaultChatThinkingRatio,
  resolveThinkingLevel,
  thinkingStops,
  type ThinkingLevel
} from '@/lib/reasoning-tier';

function placeChatModelMenu(trigger: HTMLElement | null, itemCount: number) {
  const gap = 6;
  const padding = 8;
  const width = Math.min(232, Math.max(0, window.innerWidth - padding * 2));
  if (!trigger) return { top: padding, left: padding, width };
  const rect = trigger.getBoundingClientRect();
  let left = rect.right - width;
  left = Math.min(Math.max(padding, left), window.innerWidth - padding - width);
  const estimatedHeight = Math.min(420, 112 + itemCount * 34);
  const spaceBelow = window.innerHeight - rect.bottom - padding;
  const top = spaceBelow < estimatedHeight && rect.top > spaceBelow
    ? Math.max(padding, rect.top - gap - estimatedHeight)
    : rect.bottom + gap;
  return { top, left, width };
}

/** 旋钮直径 + 两侧留白，用来把像素几何和 CSS 里的轨道尺寸对齐。 */
const THINKING_KNOB_TRAVEL_INSET = 30;

/** 档位由冷到暖，最高一档单独给一条紫粉渐变。 */
const THINKING_ACCENTS = ['#94a3b8', '#38bdf8', '#4c8dff', '#6366f1', '#a855f7'];

function thinkingAccent(ratio: number) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const index = Math.round(clamped * (THINKING_ACCENTS.length - 1));
  return THINKING_ACCENTS[index] || THINKING_ACCENTS[2];
}

/** 最高一档的流动星点，位置固定但节奏错开，避免看起来是随机噪点。 */
const THINKING_SPARKS = [
  { left: 12, top: 32, delay: 0 },
  { left: 24, top: 66, delay: 0.7 },
  { left: 37, top: 24, delay: 1.4 },
  { left: 48, top: 72, delay: 0.3 },
  { left: 58, top: 38, delay: 1.9 },
  { left: 69, top: 62, delay: 1.1 },
  { left: 79, top: 28, delay: 2.3 },
  { left: 88, top: 58, delay: 0.5 }
];

/**
 * 连续思考条：拖动时跟手不跳档，松手吸附到最近一档。
 * 轨道是一条整胶囊，填充带流光，档位在轨道内以小圆点标出。
 */
function ThinkingSlider({
  levels,
  activeId,
  locked = false,
  lockedTitle,
  onSelect
}: {
  levels: ThinkingLevel[];
  activeId: string;
  locked?: boolean;
  lockedTitle?: string;
  onSelect: (levelId: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ x: number; moved: boolean } | null>(null);
  const releaseFrameRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const span = Math.max(1, levels.length - 1);
  const activeIndex = Math.max(0, levels.findIndex((level) => level.id === activeId));
  const ratio = dragRatio ?? activeIndex / span;
  const shown = levels[Math.round(ratio * span)] || levels[activeIndex] || levels[0];
  const isMax = shown?.id === levels[levels.length - 1]?.id;

  useEffect(() => () => {
    if (releaseFrameRef.current != null) cancelAnimationFrame(releaseFrameRef.current);
  }, []);

  function ratioFromClientX(clientX: number) {
    const track = trackRef.current;
    if (!track) return ratio;
    const rect = track.getBoundingClientRect();
    const usable = rect.width - THINKING_KNOB_TRAVEL_INSET;
    if (usable <= 0) return ratio;
    return Math.min(1, Math.max(0, (clientX - rect.left - THINKING_KNOB_TRAVEL_INSET / 2) / usable));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    if (releaseFrameRef.current != null) {
      cancelAnimationFrame(releaseFrameRef.current);
      releaseFrameRef.current = null;
    }
    pressRef.current = { x: event.clientX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** 按下不立刻跟手，挪过 3px 才算拖动，这样纯点击能保留过渡动画。 */
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const press = pressRef.current;
    if (locked || !press) return;
    if (!press.moved && Math.abs(event.clientX - press.x) < 3) return;
    press.moved = true;
    setDragging(true);
    setDragRatio(ratioFromClientX(event.clientX));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>, apply: boolean) {
    if (!pressRef.current) return;
    pressRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!apply) {
      setDragging(false);
      setDragRatio(null);
      return;
    }
    const next = ratioFromClientX(event.clientX);
    // 先退出跟手模式让过渡生效，下一帧再吸附到整档，吸附过程才有动画。
    setDragging(false);
    releaseFrameRef.current = requestAnimationFrame(() => {
      releaseFrameRef.current = null;
      setDragRatio(null);
      const level = levels[Math.round(next * span)];
      if (level && level.id !== activeId) onSelect(level.id);
    });
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (locked) return;
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? -1
        : event.key === 'Home'
          ? -levels.length
          : event.key === 'End'
            ? levels.length
            : 0;
    if (!step) return;
    event.preventDefault();
    const next = levels[Math.min(levels.length - 1, Math.max(0, activeIndex + step))];
    if (next && next.id !== activeId) onSelect(next.id);
  }

  return (
    <div
      ref={trackRef}
      className={`rag-tp-track${locked ? ' is-locked' : ''}${dragging ? ' is-dragging' : ''}${isMax ? ' is-max' : ''}`}
      style={{ '--tp-ratio': ratio, '--tp-accent': thinkingAccent(ratio) } as CSSProperties}
      role={locked ? 'progressbar' : 'slider'}
      tabIndex={locked ? -1 : 0}
      aria-label="思考强度"
      aria-valuemin={1}
      aria-valuemax={levels.length}
      aria-valuenow={activeIndex + 1}
      aria-valuetext={shown ? `${shown.label}：${shown.description}` : undefined}
      aria-disabled={locked || undefined}
      title={locked ? lockedTitle : shown ? `${shown.label}：${shown.description}` : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onKeyDown={onKeyDown}
    >
      <span className="rag-tp-fill" aria-hidden>
        {isMax ? (
          <span className="rag-tp-sparks">
            {THINKING_SPARKS.map((spark) => (
              <span
                key={`${spark.left}-${spark.top}`}
                className="rag-tp-spark"
                style={{ left: `${spark.left}%`, top: `${spark.top}%`, animationDelay: `${spark.delay}s` }}
              />
            ))}
          </span>
        ) : null}
      </span>
      {levels.map((level, index) => (
        <span
          key={level.id}
          className={`rag-tp-stop${index / span <= ratio + 0.001 ? ' is-on' : ''}`}
          style={{ '--tp-stop': index / span } as CSSProperties}
          aria-hidden
        />
      ))}
      <span className="rag-tp-knob" aria-hidden />
    </div>
  );
}

export function ChatModelMenu({
  value,
  disabled = false,
  hideModelList = false,
  reasoningRatio,
  thinkingLevels,
  thinkingLocked = false,
  thinkingLockedTitle,
  onModelChange,
  onReasoningChange
}: {
  value: ChatModelId;
  disabled?: boolean;
  hideModelList?: boolean;
  reasoningRatio: number;
  thinkingLevels: ThinkingLevel[];
  thinkingLocked?: boolean;
  thinkingLockedTitle?: string;
  onModelChange: (next: ChatModelId) => void;
  onReasoningChange: (next: number) => void;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // dir 决定新视图从哪一侧滑入；none 用在首次展开，避免和面板自身的入场动画打架。
  const [nav, setNav] = useState<{ view: 'thinking' | 'models'; dir: 'forward' | 'back' | 'none' }>({
    view: 'thinking',
    dir: 'none'
  });
  const [viewHeight, setViewHeight] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const pickingModel = nav.view === 'models';
  const options: ChatModelId[] = hideModelList ? [value] : [...CHAT_MODEL_IDS];
  const thinkingLevel = resolveThinkingLevel(reasoningRatio, thinkingLevels);
  const thinkingRatios = thinkingStops(thinkingLevels);
  const thinkingIndex = Math.max(0, thinkingLevels.findIndex((level) => level.id === thinkingLevel.id));
  const thinkingRatio = thinkingIndex / Math.max(1, thinkingLevels.length - 1);
  const canPickModel = !hideModelList && !disabled;
  const itemCount = pickingModel ? options.length : 0;
  const triggerLabel = CHAT_MODEL_META[value].label;
  const triggerTitle = disabled
    ? '对话已开始，不能切换模型'
    : `${CHAT_MODEL_META[value].label}：${CHAT_MODEL_META[value].description}｜思考 ${thinkingLevel.label}`;

  const updatePosition = useCallback(() => {
    setPosition(placeChatModelMenu(buttonRef.current, itemCount));
  }, [itemCount]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    function menuButtons() {
      return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as Node | null;
      if (!target || (!rootRef.current?.contains(target) && !menuRef.current?.contains(target))) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Let the slider handle its own arrow keys instead of moving focus away.
      if (target instanceof Element && target.closest('[role="slider"]')) return;
      const buttons = menuButtons();
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.findIndex((button) => button === document.activeElement);
      const next = event.key === 'ArrowDown'
        ? (current + 1) % buttons.length
        : current <= 0
          ? buttons.length - 1
          : current - 1;
      buttons[next]?.focus();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setNav({ view: 'thinking', dir: 'none' });
      setViewHeight(null);
      return;
    }
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]');
    (selected ?? menuRef.current?.querySelector('button'))?.focus();
  }, [open, nav.view]);

  // 量出当前视图的真实高度，交给容器做高度过渡，两页高矮不同也能平滑伸缩。
  useLayoutEffect(() => {
    if (!open) return;
    const view = viewportRef.current?.firstElementChild as HTMLElement | null;
    if (view) setViewHeight(view.offsetHeight);
  }, [open, nav.view, thinkingLevels.length, value]);

  const menu = open && mounted
    ? createPortal(
        <div
          ref={menuRef}
          id={listId}
          className="rag-tp-panel"
          role="menu"
          aria-label="选择模型和思考强度"
          style={position ?? { visibility: 'hidden', top: 0, left: 0, width: 232 }}
        >
          <div
            ref={viewportRef}
            className="rag-tp-viewport"
            style={viewHeight == null ? undefined : { height: viewHeight }}
          >
            {pickingModel ? (
              <div key={`models-${nav.dir}`} className={`rag-tp-view is-${nav.dir}`} role="group">
                <button
                  type="button"
                  className="rag-tp-back"
                  onClick={() => setNav({ view: 'thinking', dir: 'back' })}
                >
                  <ChevronLeft className="rag-tp-back-icon" aria-hidden />
                  选择模型
                </button>
                {options.map((id, index) => {
                  const selected = value === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      aria-selected={selected}
                      disabled={disabled}
                      title={CHAT_MODEL_META[id].description}
                      className={`rag-tp-model-row${selected ? ' is-on' : ''}`}
                      style={{ animationDelay: `${40 + index * 35}ms` }}
                      onClick={() => {
                        if (!disabled && !selected) onModelChange(id);
                        setNav({ view: 'thinking', dir: 'back' });
                      }}
                    >
                      <span>{CHAT_MODEL_META[id].label}</span>
                      {selected ? <Check className="rag-tp-check" aria-hidden /> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div key={`thinking-${nav.dir}`} className={`rag-tp-view is-${nav.dir}`}>
                <div className="rag-tp-head">
                  <span
                    className="rag-tp-level"
                    style={{ color: thinkingAccent(thinkingRatio) }}
                  >
                    {thinkingLevel.label}
                  </span>
                  <button
                    type="button"
                    className="rag-tp-reset"
                    aria-label="恢复默认思考强度"
                    title="恢复默认思考强度"
                    disabled={thinkingLocked}
                    onClick={() => onReasoningChange(defaultChatThinkingRatio(value))}
                  >
                    <RotateCcw aria-hidden />
                  </button>
                </div>
                <button
                  type="button"
                  className="rag-tp-model"
                  disabled={!canPickModel}
                  aria-label={`当前模型 ${triggerLabel}，点击切换`}
                  title={CHAT_MODEL_META[value].description}
                  onClick={() => setNav({ view: 'models', dir: 'forward' })}
                >
                  {triggerLabel}
                  {canPickModel ? <ChevronRight className="rag-tp-model-icon" aria-hidden /> : null}
                </button>
                <ThinkingSlider
                  levels={thinkingLevels}
                  activeId={thinkingLevel.id}
                  locked={thinkingLocked}
                  lockedTitle={thinkingLockedTitle}
                  onSelect={(levelId) => onReasoningChange(thinkingRatios[levelId] ?? 0)}
                />
              </div>
            )}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={rootRef} className="rag-model-menu">
      <button
        ref={buttonRef}
        type="button"
        className={`rag-model-menu-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`当前模型 ${triggerLabel}，思考 ${thinkingLevel.label}`}
        title={triggerTitle}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setPosition(placeChatModelMenu(buttonRef.current, itemCount));
          setOpen(true);
        }}
      >
        <span className="rag-model-menu-trigger-label">{triggerLabel}</span>
        <span
          className="rag-model-menu-trigger-level"
          style={{ color: thinkingAccent(thinkingRatio) }}
        >
          {thinkingLevel.label}
        </span>
        <ChevronDown className={`rag-model-menu-chevron${open ? ' is-open' : ''}`} aria-hidden />
      </button>
      {menu}
    </div>
  );
}

