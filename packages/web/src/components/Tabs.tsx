'use client';

import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
}

/**
 * Tabs with a sliding pill. `items` are the tabs and their panels; the first is open unless `defaultId`
 * says otherwise. The left and right arrows move between tabs, Home and End jump to the first and last.
 * `label` names the tab list for screen readers. Every panel is in the page; the closed ones are hidden.
 */
export const Tabs = ({ items, defaultId, label }: { readonly items: readonly TabItem[]; readonly defaultId?: string; readonly label: string }) => {
  const [selected, setSelected] = useState(defaultId ?? items[0]?.id);
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);

  const place = useCallback(() => {
    const tab = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!tab || !pill.current)
      return;
    pill.current.style.left = `${tab.offsetLeft}px`;
    pill.current.style.width = `${tab.offsetWidth}px`;
    pill.current.classList.add('ready');
  }, []);

  useLayoutEffect(() => {
    place();
    if (!list.current)
      return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(list.current);

    return () => observer.disconnect();
  }, [place, selected]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex(item => item.id === selected);
    const target = event.key === 'ArrowRight' ? (index + 1) % items.length
      : event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : undefined;
    const next = target === undefined ? undefined : items[target];
    if (!next)
      return;
    event.preventDefault();
    setSelected(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  };

  return (
    <div className="tabs-wrap">
      <div ref={list} className="tabs scroll" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        <span ref={pill} className="pill" aria-hidden="true" />
        {items.map(item => (
          <button
            key={item.id}
            id={`${base}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={item.id === selected}
            aria-controls={`${base}-panel-${item.id}`}
            tabIndex={item.id === selected ? 0 : -1}
            onClick={() => setSelected(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map(item => (
        <div key={item.id} id={`${base}-panel-${item.id}`} className="tab-panel mt-12" role="tabpanel" aria-labelledby={`${base}-tab-${item.id}`} hidden={item.id !== selected}>
          {item.content}
        </div>
      ))}
    </div>
  );
};
