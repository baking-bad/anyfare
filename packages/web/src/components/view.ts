// Who reads the page: a person (Human) or an agent (Agent). The choice is kept in localStorage under
// `anyfare-view`. The inline script in the layout marks <html data-view="agent"> before the first paint.

import { useSyncExternalStore } from 'react';

export type View = 'human' | 'agent';

export const viewKey = 'anyfare-view';

const changed = 'anyfare-view-change';

const readView = (): View => {
  try {
    return localStorage.getItem(viewKey) === 'agent' ? 'agent' : 'human';
  }
  catch {
    return 'human';
  }
};

let current: View | undefined;

const subscribe = (notify: () => void): (() => void) => {
  const onChange = () => {
    current = readView();
    notify();
  };
  window.addEventListener(changed, onChange);
  window.addEventListener('storage', onChange);

  return () => {
    window.removeEventListener(changed, onChange);
    window.removeEventListener('storage', onChange);
  };
};

const snapshot = (): View => (current ??= readView());

/** The chosen view. It reads `human` on the server and while the page hydrates. */
export const useView = (): View => useSyncExternalStore(subscribe, snapshot, () => 'human');

/** Saves the choice, marks <html>, and tells every component that reads it. */
export const setView = (view: View): void => {
  try {
    localStorage.setItem(viewKey, view);
  }
  catch {
    // Storage is blocked: the choice holds for this page only
  }
  current = view;
  if (view === 'agent')
    document.documentElement.setAttribute('data-view', 'agent');
  else
    document.documentElement.removeAttribute('data-view');
  window.dispatchEvent(new Event(changed));
  window.scrollTo(0, 0);
};
