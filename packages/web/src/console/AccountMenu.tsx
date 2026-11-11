'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { copyText } from './clipboard';
import { useToast } from './components/Toast';
import { useConsoleData } from './context';
import { shortMasked, signOut, type MaskedKey } from './session';

/**
 * The account menu at the top right: the key it is signed in with, masked, then "Copy account id", Settings and Sign
 * out. Arrow keys move in it, Escape and a click outside close it.
 */
export const AccountMenu = ({ masked }: { readonly masked: MaskedKey }) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { account, readAccountAgain } = useConsoleData();
  const toast = useToast();

  useEffect(() => {
    if (!open)
      return undefined;
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
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };

  const copyAccountId = async (): Promise<void> => {
    close();
    if (account.state !== 'ok') {
      readAccountAgain();
      toast('The account id didn\'t load. Try again in a moment.');

      return;
    }
    toast(await copyText(account.value.id) ? 'Account id copied' : 'The browser didn\'t let the console copy it');
  };

  return (
    <div ref={root} className="acct-menu">
      <button
        ref={button}
        type="button"
        className="btn outline sm acct"
        aria-label={`Account, signed in with ${shortMasked(masked)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="av"><Icon name="user" /></span>
        <span className="mono hide-sm">…{masked.end}</span>
        <Icon name="down" />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Account">
          <div className="menu-head" role="none">
            <div className="xs muted">Signed in with the master key</div>
            <div className="mono small">{shortMasked(masked)}</div>
          </div>
          <button type="button" role="menuitem" onClick={() => void copyAccountId()}><Icon name="copy" />Copy account id</button>
          <Link role="menuitem" href="/settings" onClick={() => setOpen(false)}><Icon name="settings" />Settings</Link>
          <div className="sep" role="none" />
          <button type="button" role="menuitem" onClick={() => signOut()}><Icon name="arrow" />Sign out</button>
        </div>
      ) : null}
    </div>
  );
};
