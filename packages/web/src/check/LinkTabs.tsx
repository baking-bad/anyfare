'use client';

import { useId, useState, useEffect, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

export interface LinkTab {
  readonly id: string;
  readonly label: ReactNode;
  // The address that opens the same tab: it works without scripts
  readonly href: string;
  readonly content: ReactNode;
}

/**
 * Tabs whose choice lives in the URL. Each tab is a link to the page with `&tab=`, so a link opens the same
 * tab and the page works without scripts. With scripts a click shows the panel at once and rewrites the
 * address, with no request. The arrows, Home and End move between tabs. The tab list scrolls sideways inside
 * its own box when the tabs don't fit.
 */
export const LinkTabs = ({ items, selected: chosen, label }: { readonly items: readonly LinkTab[]; readonly selected: string; readonly label: string }) => {
  const [selected, setSelected] = useState(chosen);
  const base = useId();
  useEffect(() => setSelected(chosen), [chosen]);

  const choose = (item: LinkTab): void => {
    setSelected(item.id);
    // Built from the address as it is now, so a period or a page chosen since the page loaded stays
    const url = new URL(window.location.href);
    if (item.id === items[0]?.id)
      url.searchParams.delete('tab');
    else
      url.searchParams.set('tab', item.id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };

  const onClick = (event: MouseEvent<HTMLAnchorElement>, item: LinkTab): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    choose(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex(item => item.id === selected);
    const target = event.key === 'ArrowRight' ? (index + 1) % items.length
      : event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : undefined;
    const next = target === undefined ? undefined : items[target];
    if (next === undefined)
      return;
    event.preventDefault();
    choose(next);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  };

  return (
    <div className="tabs-wrap link-tabs">
      <div className="tabs scroll" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map(item => (
          <a
            key={item.id}
            id={`${base}-tab-${item.id}`}
            role="tab"
            href={item.href}
            aria-selected={item.id === selected}
            aria-controls={`${base}-panel-${item.id}`}
            tabIndex={item.id === selected ? 0 : -1}
            onClick={event => onClick(event, item)}
          >
            {item.label}
          </a>
        ))}
      </div>
      {items.map(item => (
        <div key={item.id} id={`${base}-panel-${item.id}`} className="tab-panel mt-24" role="tabpanel" aria-labelledby={`${base}-tab-${item.id}`} hidden={item.id !== selected}>
          {item.content}
        </div>
      ))}
    </div>
  );
};
