'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type UiSelectOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  placement: 'bottom' | 'top';
};

export function UiSelect<T extends string = string>({
  value,
  options,
  onChange,
  disabled = false,
  className,
  size = 'sm',
  placeholder = '请选择',
  'aria-label': ariaLabel
}: {
  value: T | '';
  options: UiSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  placeholder?: string;
  'aria-label'?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const selected = options.find((option) => option.value === value) || null;
  const enabledIndexes = useMemo(
    () => options
      .map((option, index) => (option.disabled ? -1 : index))
      .filter((index) => index >= 0),
    [options]
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    function updatePosition() {
      const trigger = buttonRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const gap = 6;
      const viewportPadding = 8;
      const estimatedMenuHeight = Math.min(280, options.length * 40 + 8);
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
      const spaceAbove = rect.top - viewportPadding;
      const placement: 'bottom' | 'top' =
        spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow ? 'top' : 'bottom';
      const maxHeight = Math.max(
        120,
        Math.min(280, placement === 'bottom' ? spaceBelow - gap : spaceAbove - gap)
      );
      const maxWidth = Math.min(26 * 16, window.innerWidth - viewportPadding * 2);
      const minWidth = Math.min(maxWidth, Math.max(rect.width, 160));
      const measured = menuRef.current?.scrollWidth ?? 0;
      const width = measured > 0 ? Math.min(maxWidth, Math.max(minWidth, measured)) : 0;
      const boxWidth = width || minWidth;
      let left = rect.left;
      if (left + boxWidth > window.innerWidth - viewportPadding) {
        left = Math.max(viewportPadding, window.innerWidth - viewportPadding - boxWidth);
      } else {
        left = Math.max(viewportPadding, left);
      }
      const top = placement === 'bottom'
        ? rect.bottom + gap
        : Math.max(viewportPadding, rect.top - gap - maxHeight);

      setPosition((prev) => {
        const next = { top, left, width, minWidth, maxWidth, maxHeight, placement };
        if (
          prev
          && prev.top === next.top
          && prev.left === next.left
          && prev.width === next.width
          && prev.minWidth === next.minWidth
          && prev.maxWidth === next.maxWidth
          && prev.maxHeight === next.maxHeight
          && prev.placement === next.placement
        ) {
          return prev;
        }
        return next;
      });
    }

    updatePosition();
    const frame = window.requestAnimationFrame(() => {
      updatePosition();
      menuRef.current?.focus();
    });
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
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
      setHighlight(-1);
      return;
    }
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    setHighlight(selectedIndex >= 0 ? selectedIndex : enabledIndexes[0] ?? -1);
  }, [open, options, value, enabledIndexes]);

  function moveHighlight(direction: 1 | -1) {
    if (!enabledIndexes.length) return;
    const currentPos = enabledIndexes.indexOf(highlight);
    const nextPos = currentPos < 0
      ? direction > 0 ? 0 : enabledIndexes.length - 1
      : (currentPos + direction + enabledIndexes.length) % enabledIndexes.length;
    const nextIndex = enabledIndexes[nextPos];
    setHighlight(nextIndex);
    window.requestAnimationFrame(() => {
      document.getElementById(`${listId}-opt-${nextIndex}`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onButtonKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (highlight >= 0) choose(highlight);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (enabledIndexes.length) setHighlight(enabledIndexes[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      if (enabledIndexes.length) setHighlight(enabledIndexes[enabledIndexes.length - 1]);
    }
  }

  const menu = open && mounted && position
    ? createPortal(
        <div
          className="ui-select-menu"
          style={{
            top: position.top,
            left: position.left,
            width: position.width > 0 ? position.width : 'max-content',
            minWidth: position.minWidth,
            maxWidth: position.maxWidth
          }}
        >
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={highlight >= 0 ? `${listId}-opt-${highlight}` : undefined}
            className="ui-select-menu-list"
            style={{ maxHeight: position.maxHeight }}
            onKeyDown={onMenuKeyDown}
          >
            {options.map((option, index) => {
              const active = option.value === value;
              const highlighted = index === highlight;
              return (
                <button
                  key={`${option.value}-${index}`}
                  id={`${listId}-opt-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={option.disabled}
                  className={cn(
                    'ui-select-option',
                    active && 'ui-select-option-active',
                    highlighted && 'ui-select-option-highlight'
                  )}
                  onMouseEnter={() => {
                    if (!option.disabled) setHighlight(index);
                  }}
                  onClick={() => choose(index)}
                >
                  <span className="ui-select-option-label">{option.label}</span>
                  {active ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80" /> : null}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={rootRef} className={cn('ui-select', className)}>
      <button
        ref={buttonRef}
        type="button"
        className={cn('ui-select-trigger', size === 'sm' && 'ui-select-trigger-sm', open && 'ui-select-trigger-open')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        onKeyDown={onButtonKeyDown}
      >
        <span className={cn('ui-select-value', !selected && 'text-muted-foreground')}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown
          className={cn('ui-select-chevron', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {menu}
    </div>
  );
}
