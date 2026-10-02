'use client';

import { useEffect } from 'react';

const EDGE_PX = 18;
const HOT_CLASS = 'scrollbar-edge-hot';
const DRAG_CLASS = 'scrollbar-edge-drag';

function canScrollY(node: HTMLElement) {
  const style = window.getComputedStyle(node);
  const overflowY = style.overflowY;
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
  return node.scrollHeight > node.clientHeight + 1;
}

function clearHot(except?: HTMLElement | null) {
  document.querySelectorAll(`.${HOT_CLASS}`).forEach((node) => {
    if (except && node === except) return;
    node.classList.remove(HOT_CLASS);
  });
}

export function ScrollbarEdgeReveal() {
  useEffect(() => {
    let dragging: HTMLElement | null = null;
    let frame = 0;

    const updateFromPoint = (clientX: number, clientY: number) => {
      if (dragging) return;
      const stack = document.elementsFromPoint(clientX, clientY) as HTMLElement[];
      let matched: HTMLElement | null = null;

      for (const start of stack) {
        let node: HTMLElement | null = start;
        while (node && node !== document.documentElement) {
          if (canScrollY(node)) {
            const rect = node.getBoundingClientRect();
            const nearRight = clientX >= rect.right - EDGE_PX && clientX <= rect.right + 2;
            const insideY = clientY >= rect.top && clientY <= rect.bottom;
            if (nearRight && insideY) {
              matched = node;
              break;
            }
          }
          node = node.parentElement;
        }
        if (matched) break;
      }

      clearHot(matched);
      matched?.classList.add(HOT_CLASS);
    };

    const onMove = (event: MouseEvent) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateFromPoint(event.clientX, event.clientY);
      });
    };

    const onLeave = () => {
      if (!dragging) clearHot();
    };

    const onDown = (event: MouseEvent) => {
      updateFromPoint(event.clientX, event.clientY);
      const hot = document.querySelector(`.${HOT_CLASS}`) as HTMLElement | null;
      if (!hot) return;
      dragging = hot;
      hot.classList.add(DRAG_CLASS);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging.classList.remove(DRAG_CLASS);
      dragging = null;
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mousedown', onDown, { passive: true });
    window.addEventListener('mouseup', onUp, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeave);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      clearHot();
      document.querySelectorAll(`.${DRAG_CLASS}`).forEach((node) => node.classList.remove(DRAG_CLASS));
    };
  }, []);

  return null;
}
