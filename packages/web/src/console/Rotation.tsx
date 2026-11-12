'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { useSettings } from '../components/Settings';
import { Spinner } from '../components/Spinner';
import { Dialog } from './components/Dialog';
import { useToast } from './components/Toast';
import { NewKeyDialog } from './NewKeyDialog';
import { oneAtATime, rotateAndCheck, type RotateOutcome } from './rotate';

// The rotation lives above the console's pages and above its sign-in switch: a page that is left, turns into its Agent
// view, or a session that ends while the request runs doesn't take the new key with it. While the request runs, a modal
// covers the console, so the person can't move away or sign out by a click. One rotation runs at a time in a tab.

/** What a page learns of a rotation: everything but the new key, which only the dialog holds. */
export type RotateResult =
  | Exclude<RotateOutcome, { readonly kind: 'rotated' } | { readonly kind: 'rotatedElsewhere' }>
  | { readonly kind: 'rotated' }
  | { readonly kind: 'rotatedElsewhere' };

interface Rotation {
  readonly rotate: () => Promise<RotateResult>;
  // A rotation is running in this tab
  readonly running: boolean;
}

const Context = createContext<Rotation | undefined>(undefined);

interface Shown {
  readonly masterKey: string;
  // How it went: kept for the session that asked, not kept by this browser, or come after that session had ended
  readonly how: 'kept' | 'blocked' | 'elsewhere';
}

const lines: Readonly<Record<Shown['how'], string>> = {
  kept: 'This is your new master key. We show it once. The old one no longer works.',
  blocked: 'This is your new master key. We show it once. The old one no longer works.',
  elsewhere: 'You signed out while the key was rotated. This is the account\'s new master key. Copy it now: it is shown once.',
};

const notKept = 'This browser didn\'t keep the new key, so you are signed out. Copy it now: it is the only way back in.';

/** Holds a rotation's new key, in memory only, and shows it once. Cleared on Continue, and when the page is left. */
export const RotationProvider = ({ children }: { readonly children: ReactNode }) => {
  const { apiUrl } = useSettings();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState<Shown | undefined>(undefined);

  // Cleared at once, so a page frozen into the back-forward cache holds no key
  useEffect(() => {
    if (shown === undefined)
      return undefined;
    const drop = (): void => flushSync(() => setShown(undefined));
    window.addEventListener('pagehide', drop);

    return () => window.removeEventListener('pagehide', drop);
  }, [shown]);

  const rotate = useMemo(() => oneAtATime(async (): Promise<RotateResult> => {
    setRunning(true);
    try {
      const outcome = await rotateAndCheck(apiUrl);
      if (outcome.kind === 'rotated') {
        setShown({ masterKey: outcome.masterKey, how: outcome.kept ? 'kept' : 'blocked' });

        return { kind: 'rotated' };
      }
      if (outcome.kind === 'rotatedElsewhere') {
        setShown({ masterKey: outcome.masterKey, how: 'elsewhere' });

        return { kind: 'rotatedElsewhere' };
      }

      return outcome;
    }
    finally {
      setRunning(false);
    }
  }), [apiUrl]);

  // Continue closes the dialog; it never touches a session that came after the rotation
  const done = (): void => {
    const how = shown?.how;
    setShown(undefined);
    if (how === 'kept')
      toast('New master key made');
    // The dialog that had the focus is gone: it goes back to the Rotate button, or to the page's heading when that is gone too
    setTimeout(() => {
      const target = document.querySelector<HTMLElement>('.key-row .btn') ?? document.querySelector<HTMLElement>('main h1');
      if (target === null)
        return;
      if (target.tabIndex < 0)
        target.tabIndex = -1;
      target.focus();
    }, 0);
  };

  const value = useMemo(() => ({ rotate, running }), [rotate, running]);

  return (
    <Context.Provider value={value}>
      {children}
      {running ? (
        <Dialog title="Rotating the master key…" icon="refresh">
          <p className="row muted"><Spinner label="Waiting for the Anyfare API" />Waiting for the Anyfare API. The old key stops the moment the new one is made.</p>
        </Dialog>
      ) : null}
      {shown === undefined ? null : (
        <NewKeyDialog
          title="Your new master key"
          lead={lines[shown.how]}
          masterKey={shown.masterKey}
          {...shown.how === 'blocked' ? { problem: notKept } : {}}
          onContinue={done}
        />
      )}
    </Context.Provider>
  );
};

/** The tab's rotation: start it (a second call while it runs gets the same one), and whether it is running. */
export const useRotation = (): Rotation => {
  const value = useContext(Context);
  if (value === undefined)
    throw new Error('useRotation needs a RotationProvider above it');

  return value;
};
