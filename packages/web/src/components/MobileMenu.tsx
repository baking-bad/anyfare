'use client';

import { useEffect, useRef, useState } from 'react';

import { Icon } from './Icon';
import { NavLinks } from './NavLinks';
import { ViewSwitch } from './ViewSwitch';

/**
 * The main links behind a button, for narrow screens. The menu closes on Escape, on a click outside, and
 * on a link, and the focus goes back to the button. It traps no focus: Tab leaves it as it would any list.
 */
export const MobileMenu = () => {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open)
      return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target))
        setOpen(false);
    };
    const wide = matchMedia('(min-width: 900px)');
    const onWide = () => {
      if (wide.matches)
        setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    wide.addEventListener('change', onWide);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  return (
    <>
      <button ref={button} type="button" className="btn ghost icon sm menu-button" aria-label={open ? 'Close the menu' : 'Open the menu'} aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'x' : 'menu'} />
      </button>
      {open ? (
        <div ref={panel} id="mobile-menu" className="mobile-menu">
          <div className="container">
            <nav className="stack" aria-label="Main">
              <NavLinks onNavigate={() => {
                setOpen(false);
                button.current?.focus();
              }}
              />
            </nav>
            <div className="menu-view only-sm"><ViewSwitch /></div>
          </div>
        </div>
      ) : null}
    </>
  );
};
