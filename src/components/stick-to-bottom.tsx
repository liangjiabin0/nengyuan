'use client';

import { ArrowDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { cn } from '@/lib/utils';

/** Distance from the bottom that counts as “at the end” for re-pinning. */
const NEAR_BOTTOM_PX = 64;
/** After the user scrolls up, ignore near-bottom re-pin for a short window. */
const UNPIN_HOLD_MS = 180;

function distanceFromBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isOverflowing(el: HTMLElement) {
  return el.scrollHeight > el.clientHeight + 1;
}

/**
 * Chat-style stick-to-bottom: follow new output only while the viewport is at
 * the end. Scrolling up releases the pin and shows a jump-to-bottom control.
 */
export function StickToBottomFrame({
  children,
  className,
  contentClassName,
  followKey,
  resetKey,
  wrapperClassName
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  followKey?: string | number;
  resetKey?: string | number;
  wrapperClassName?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const ignoreRepinUntilRef = useRef(0);
  const programmaticRef = useRef(false);
  const programmaticTimerRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  const syncJump = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setShowJump(false);
      return;
    }
    setShowJump(isOverflowing(el) && !pinnedRef.current);
  }, []);

  const beginProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    window.clearTimeout(programmaticTimerRef.current);
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticRef.current = false;
    }, 120);
  }, []);

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    beginProgrammatic();
    el.scrollTop = el.scrollHeight;
  }, [beginProgrammatic]);

  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next;
    if (next) ignoreRepinUntilRef.current = 0;
    syncJump();
  }, [syncJump]);

  const stickIfPinned = useCallback(() => {
    if (pinnedRef.current) scrollToEnd();
    syncJump();
  }, [scrollToEnd, syncJump]);

  const jumpToBottom = useCallback(() => {
    setPinned(true);
    scrollToEnd();
  }, [scrollToEnd, setPinned]);

  const unpinFromUser = useCallback(() => {
    ignoreRepinUntilRef.current = performance.now() + UNPIN_HOLD_MS;
    setPinned(false);
  }, [setPinned]);

  const onScroll = useCallback(() => {
    if (programmaticRef.current) {
      syncJump();
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const distance = distanceFromBottom(el);
    if (distance > NEAR_BOTTOM_PX) {
      setPinned(false);
      return;
    }
    if (performance.now() < ignoreRepinUntilRef.current) {
      syncJump();
      return;
    }
    setPinned(true);
  }, [setPinned, syncJump]);

  useLayoutEffect(() => {
    pinnedRef.current = true;
    ignoreRepinUntilRef.current = 0;
    scrollToEnd();
    syncJump();
    const timers = [50, 200, 500].map((ms) =>
      window.setTimeout(() => {
        if (pinnedRef.current) scrollToEnd();
      }, ms)
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [resetKey, scrollToEnd, syncJump]);

  useEffect(() => () => window.clearTimeout(programmaticTimerRef.current), []);

  useLayoutEffect(() => {
    stickIfPinned();
  }, [followKey, stickIfPinned]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => stickIfPinned());
    observer.observe(el);
    if (content) observer.observe(content);
    const mutations = new MutationObserver(() => stickIfPinned());
    mutations.observe(content || el, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [resetKey, stickIfPinned]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) unpinFromUser();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchYRef.current = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y == null) return;
      if (touchYRef.current != null && y - touchYRef.current > 2) unpinFromUser();
      touchYRef.current = y;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [resetKey, unpinFromUser]);

  return (
    <div className={cn('rag-stick-frame', wrapperClassName)}>
      <div
        ref={scrollRef}
        className={cn('rag-stick-scroll', className)}
        onScroll={onScroll}
      >
        <div ref={contentRef} className={cn('flex min-h-full flex-col', contentClassName)}>
          {children}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          className="rag-scroll-jump"
          onClick={jumpToBottom}
          aria-label="回到最下方"
          title="回到最下方"
        >
          <ArrowDown aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
