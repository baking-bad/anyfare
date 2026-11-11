'use client';

import { useEffect, useRef, type RefObject } from 'react';

const focusable = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls inside `root` that Tab reaches, in order: the ones that are shown. */
export const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(focusable)].filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');

/**
 * While `active`, the focus stays inside `ref`: it starts on the first control, Tab and Shift+Tab wrap around, and
 * focus that lands outside comes back. Escape calls `onEscape`, and does nothing when there is none, so a box
 * that must not close stays open. When it ends, the focus goes back to where it was.
 */
export const useFocusTrap = (ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void): void => {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });

  useEffect(() => {
    const root = ref.current;
    if (!active || root === null)
      return undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = (): HTMLElement => focusablesIn(root)[0] ?? root;
    first().focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escape.current?.();

        return;
      }
      if (event.key !== 'Tab')
        return;
      const items = focusablesIn(root);
      const at = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
      }
      else if (event.shiftKey && (at === items[0] || !root.contains(at))) {
        event.preventDefault();
        items.at(-1)!.focus();
      }
      else if (!event.shiftKey && (at === items.at(-1) || !root.contains(at))) {
        event.preventDefault();
        items[0]!.focus();
      }
    };
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !root.contains(event.target))
        first().focus();
    };
    // Captured, so a menu behind the box doesn't also take the key
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      if (before !== null && before.isConnected)
        before.focus();
    };
  }, [active, ref]);
};
