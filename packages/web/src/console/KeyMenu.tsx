'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import { copyText } from './clipboard';
import { useToast } from './components/Toast';
import { keyName } from './keys';
import type { PaymentKey } from './api';

/**
 * The menu at the end of a key's row: Change limits, Copy key id, Revoke. Arrow keys move in it; Escape and a click
 * outside, a scroll and a resize close it, and the focus goes back to its button. The menu is drawn on the page's body,
 * `position: fixed`, placed from the button's rectangle (below it and right-aligned, above it when there is no room
 * below, and inside the window), so no box of the table can cut it.
 */
export const KeyMenu = ({ keyRecord, onLimits, onRevoke }: {
  readonly keyRecord: PaymentKey;
  readonly onLimits: () => void;
  readonly onRevoke: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toast = useToast();

  // Placed before it is painted: below the button, right-aligned, flipped above when there is no room, kept in the window
  useLayoutEffect(() => {
    const box = menu.current;
    const anchor = button.current;
    if (!open || box === null || anchor === null)
      return;
    const rect = anchor.getBoundingClientRect();
    const [width, height] = [box.offsetWidth, box.offsetHeight];
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    const below = rect.bottom + 4;
    const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, rect.top - 4 - height);
    box.style.setProperty('left', `${left}px`);
    box.style.setProperty('top', `${top}px`);
  }, [open]);

  useEffect(() => {
    if (!open)
      return undefined;
    const items = (): HTMLElement[] => [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []];
    items()[0]?.focus({ preventScroll: true });
    const close = (): void => setOpen(false);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const all = items();
        const at = all.indexOf(document.activeElement as HTMLElement);
        all[(at + (event.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      }
      else if (event.key === 'Tab') {
        setOpen(false);
      }
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    // A scroll of the page or of any box in it, and a resize, move the button from under the menu
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // The focus goes to the button first, so the dialog that follows hands it back there when it closes
  const choose = (action: () => void): void => {
    setOpen(false);
    button.current?.focus();
    action();
  };

  const copyId = async (): Promise<void> => {
    setOpen(false);
    button.current?.focus();
    toast(await copyText(keyRecord.id) ? 'Key id copied' : 'The browser didn\'t let the console copy it');
  };

  return (
    <div className="key-menu">
      <button
        ref={button}
        type="button"
        className="btn ghost icon sm"
        aria-label={`Menu of the key ${keyName(keyRecord)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="dots" />
      </button>
      {open ? createPortal(
        <div ref={menu} className="menu key-menu-float" role="menu" aria-label={`Key ${keyName(keyRecord)}`}>
          <button type="button" role="menuitem" onClick={() => choose(onLimits)}><Icon name="settings" />Change limits</button>
          <button type="button" role="menuitem" onClick={() => void copyId()}><Icon name="copy" />Copy key id</button>
          <div className="sep" role="none" />
          <button type="button" role="menuitem" className="danger-item" onClick={() => choose(onRevoke)}><Icon name="trash" />Revoke</button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
};
