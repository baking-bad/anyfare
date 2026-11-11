'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

// A thin bar at the top of the page for a move inside the site that takes a moment. The router has no
// events to listen to, so the bar watches for what starts a move (a click on a link of the site, or a
// `startNavigation` call) and for what ends one (the address changing, which is when the router commits
// the new page).

/** A move shorter than this shows nothing. */
export const slowMs = 150;

/** The bar goes away on its own after this long, whatever happened, so it can't stay. */
export const giveUpMs = 15_000;

const startEvent = 'anyfare-navigation-start';

/** Tells the bar a move has begun, for a move that isn't a click on a link, such as a router call. */
export const startNavigation = (): void => {
  window.dispatchEvent(new Event(startEvent));
};

// Whether a click on this link leaves the page for another address of the site, in this tab
const movesWithin = (event: MouseEvent, anchor: HTMLAnchorElement): boolean => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return false;
  if ((anchor.target !== '' && anchor.target !== '_self') || anchor.hasAttribute('download'))
    return false;
  const next = new URL(anchor.href, window.location.href);
  if (next.origin !== window.location.origin)
    return false;

  return next.pathname + next.search !== window.location.pathname + window.location.search;
};

/** The progress bar. Put it once in the layout, inside a `Suspense`. It is hidden from screen readers; a polite status line says the page is loading. */
export const NavigationProgress = () => {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [visible, setVisible] = useState(false);
  const running = useRef(false);
  const timers = useRef<{ show?: ReturnType<typeof setTimeout>; giveUp?: ReturnType<typeof setTimeout> }>({});

  const finish = useRef((): void => {
    clearTimeout(timers.current.show);
    clearTimeout(timers.current.giveUp);
    running.current = false;
    setVisible(false);
  });

  useEffect(() => {
    const begin = (): void => {
      if (running.current)
        return;
      running.current = true;
      timers.current.show = setTimeout(() => setVisible(true), slowMs);
      timers.current.giveUp = setTimeout(() => finish.current(), giveUpMs);
    };
    const onClick = (event: MouseEvent): void => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (anchor instanceof HTMLAnchorElement && movesWithin(event, anchor))
        begin();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener(startEvent, begin);
    window.addEventListener('popstate', () => finish.current());

    // The router, and the pages that write the address themselves, call these when a move is done
    const { pushState, replaceState } = window.history;
    const patched = (original: History['pushState']): History['pushState'] => function (this: History, ...args) {
      const answer = original.apply(this, args);
      queueMicrotask(() => finish.current());

      return answer;
    };
    window.history.pushState = patched(pushState);
    window.history.replaceState = patched(replaceState);

    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener(startEvent, begin);
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      finish.current();
    };
  }, []);

  // The new page is in: the address the router shows is another one
  useEffect(() => {
    finish.current();
  }, [pathname, search]);

  return (
    <>
      <div className="progress" hidden={!visible} aria-hidden="true"><span /></div>
      <span className="sr-only" role="status" aria-live="polite">{visible ? 'Loading the page' : ''}</span>
    </>
  );
};
