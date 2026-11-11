'use client';

import { useEffect, useRef, useState } from 'react';

import { Icon, type IconName } from './Icon';
import { readThemeChoice, setThemeChoice, showTheme, type ThemeChoice } from './theme';

const choices: readonly { readonly value: ThemeChoice; readonly label: string; readonly icon: IconName }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

/**
 * The theme menu: Light, Dark, System. The choice is kept in this browser. With System the page follows
 * the system's setting as it changes. Arrow keys move in the menu, Escape closes it.
 */
export const ThemeMenu = () => {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // With System, follow the system's setting live
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const follow = () => {
      if (readThemeChoice() === 'system')
        showTheme('system');
    };
    query.addEventListener('change', follow);

    return () => query.removeEventListener('change', follow);
  }, []);

  useEffect(() => {
    if (!open)
      return undefined;
    const items = () => [...root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []];
    (items().find(item => item.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const all = items();
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        all[(at + (event.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      }
      else if (event.key === 'Tab') {
        setOpen(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const toggle = () => {
    if (!open)
      setChoice(readThemeChoice());
    setOpen(!open);
  };

  return (
    <div ref={root} className="theme-menu">
      <button ref={button} type="button" className="btn ghost icon sm" aria-label="Theme" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <Icon name="sun" className="theme-icon-light" />
        <Icon name="moon" className="theme-icon-dark" />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Theme">
          {choices.map(item => (
            <button
              key={item.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice === item.value}
              onClick={() => {
                setThemeChoice(item.value);
                setChoice(item.value);
                setOpen(false);
                button.current?.focus();
              }}
            >
              <Icon name={item.icon} />
              {item.label}
              {choice === item.value ? <span className="menu-check"><Icon name="check" /></span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
