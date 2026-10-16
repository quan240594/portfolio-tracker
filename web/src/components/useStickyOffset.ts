import { useLayoutEffect, type RefObject } from 'react';

const VAR = '--sticky-offset';

/** Height of what is really pinned: the wrapper itself (`sm` and up), or its sticky children when it is `display: contents`. */
function pinnedHeight(el: HTMLElement): number {
  if (getComputedStyle(el).display !== 'contents') return el.offsetHeight;
  let total = 0;
  for (const child of Array.from(el.children) as HTMLElement[]) {
    if (getComputedStyle(child).position === 'sticky') total += child.offsetHeight;
  }
  return total;
}

/**
 * Publishes the height of the pinned top bar as the CSS variable `--sticky-offset` on <html>; `index.css` feeds it to
 * `scroll-padding-top` so focused elements and in-page anchors never end up underneath the bar (WCAG 2.2 focus not obscured).
 * Re-measured on resizes of the wrapper or its children and on viewport changes (breakpoint switches change what is pinned).
 */
export function useStickyOffset(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty(VAR, `${pinnedHeight(el)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty(VAR);
    };
  }, [ref]);
}
