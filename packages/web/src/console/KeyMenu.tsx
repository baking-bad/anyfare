'use client';

import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { copyText } from './clipboard';
import { useToast } from './components/Toast';
import { keyName } from './keys';
import type { PaymentKey } from './api';

/**
 * The menu at the end of a key's row: Change limits, Copy key id, Revoke. Arrow keys move in it; Escape and a click
 * outside close it, and the focus goes back to its button. `onOpen` tells the table a menu is open, so its box can leave room.
 */
export const KeyMenu = ({ keyRecord, onLimits, onRevoke, onOpen }: {
  readonly keyRecord: PaymentKey;
  readonly onLimits: () => void;
  readonly onRevoke: () => void;
  readonly onOpen: (open: boolean) => void;
}) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open)
      return undefined;
    onOpen(true);
    const items = (): HTMLElement[] => [...root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []];
    items()[0]?.focus();
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
      if (!root.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);

    return () => {
      onOpen(false);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
    // `onOpen` is a new function on every render of the page; the menu's own state is what asks for the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div ref={root} className="key-menu">
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
      {open ? (
        <div className="menu" role="menu" aria-label={`Key ${keyName(keyRecord)}`}>
          <button type="button" role="menuitem" onClick={() => choose(onLimits)}><Icon name="settings" />Change limits</button>
          <button type="button" role="menuitem" onClick={() => void copyId()}><Icon name="copy" />Copy key id</button>
          <div className="sep" role="none" />
          <button type="button" role="menuitem" className="danger-item" onClick={() => choose(onRevoke)}><Icon name="trash" />Revoke</button>
        </div>
      ) : null}
    </div>
  );
};
