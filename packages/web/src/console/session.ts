import { useSyncExternalStore } from 'react';

// The console's session: the master key, kept in this browser tab's sessionStorage under one name, and nowhere
// else. This module is the only code that touches storage for it. The key is read from storage each time a
// request needs it (see api.ts); what the pages hold is the session's state and the key's masked form: its
// prefix and its last 4 characters. The tab forgets the key when it closes, and on sign-out.

/** The one storage name of the master key. */
export const sessionStorageName = 'anyfare-console-master-key';

/** The masked form of a key: its prefix, such as `afm_live_`, and its last 4 characters. */
export interface MaskedKey {
  readonly prefix: string;
  readonly end: string;
}

/**
 * Why the session ended, when it didn't end by a sign-out: `expired`, the API refused the stored key; `lost`, a rotation
 * changed the key but its answer, the new key, never reached this browser.
 */
export type SessionNotice = 'expired' | 'lost';

/**
 * - `unknown`: on the server, and while the page hydrates: nothing about the session is known.
 * - `signedOut`: no key in this tab. `notice` says why, when it didn't end by a sign-out.
 * - `signedIn`: a key is stored. `freeCredits` is the amount a sign-up in this visit gave, kept in memory only.
 */
export type Session =
  | { readonly status: 'unknown' }
  | { readonly status: 'signedOut'; readonly notice?: SessionNotice }
  | { readonly status: 'signedIn'; readonly key: MaskedKey; readonly freeCredits?: string };

/** What the sign-in view says when the API refused the stored key. */
export const expiredNotice = 'This master key no longer works. Paste the current one.';

/** What the sign-in view says when a rotation changed the key and the new one never arrived. */
export const lostNotice = {
  title: 'The master key was changed, but the new one didn\'t reach this browser',
  text: 'The Anyfare API made a new master key and stopped the old one, but its answer never arrived here, so this account can\'t be opened from this browser any more. Rotating took nothing from the balance: the Credits stay on the account and its payment keys keep working, but without the master key no one can manage it. If another tab of this browser rotated it, the new key is there.',
} as const;

/** The masked form of a key. A key without the usual prefix shows only its end. */
export const maskKey = (key: string): MaskedKey => {
  const prefix = /^[a-z]{2,8}_[a-z]{2,8}_/.exec(key)?.[0] ?? '';

  return { prefix, end: key.length - prefix.length > 8 ? key.slice(-4) : '' };
};

/** `afm_live_…3f9a`: the menu's form. */
export const shortMasked = ({ prefix, end }: MaskedKey): string => `${prefix}…${end}`;

/** `afm_live_••••••••••••••••3f9a`: the Settings form. */
export const longMasked = ({ prefix, end }: MaskedKey): string => `${prefix}${'•'.repeat(16)}${end}`;

const storage = (): Storage | undefined => {
  try {
    return globalThis.sessionStorage ?? undefined;
  }
  catch {
    // A browser that blocks storage throws on the property itself
    return undefined;
  }
};

/** The stored master key, read now. Only api.ts calls it, to send a request. */
export const readMasterKey = (): string | undefined => {
  try {
    const value = storage()?.getItem(sessionStorageName);

    return value === null || value === undefined || value === '' ? undefined : value;
  }
  catch {
    return undefined;
  }
};

// Stores the key, and says whether it was kept
const writeMasterKey = (key: string): boolean => {
  try {
    const store = storage();
    if (store === undefined)
      return false;
    store.setItem(sessionStorageName, key);

    return store.getItem(sessionStorageName) === key;
  }
  catch {
    return false;
  }
};

const removeMasterKey = (): void => {
  try {
    storage()?.removeItem(sessionStorageName);
  }
  catch {
    // Nothing was kept
  }
};

const unknown: Session = { status: 'unknown' };
let current: Session | undefined;
const listeners = new Set<() => void>();

const publish = (next: Session): void => {
  current = next;
  for (const listener of listeners)
    listener();
};

const fromStorage = (): Session => {
  const key = readMasterKey();

  return key === undefined ? { status: 'signedOut' } : { status: 'signedIn', key: maskKey(key) };
};

/** The session as it is now. */
export const sessionNow = (): Session => (current ??= fromStorage());

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

/** The session, for a component. It is `unknown` on the server and while the page hydrates. */
export const useSession = (): Session => useSyncExternalStore(subscribe, sessionNow, () => unknown);

/**
 * Signs in with a key the API accepted: the key is stored, and the session is signed in. False when this browser
 * didn't keep it: the session stays as it was. `freeCredits` is a sign-up's amount, for the Overview's banner.
 */
export const signIn = (key: string, { freeCredits }: { readonly freeCredits?: string } = {}): boolean => {
  if (!writeMasterKey(key))
    return false;
  publish({ status: 'signedIn', key: maskKey(key), ...freeCredits === undefined ? {} : { freeCredits } });

  return true;
};

/**
 * Puts a rotated key in place of `previous`, the key that asked for it, which stopped working at once. Only while
 * `previous` is still the stored key: `changed` when the session ended or changed meanwhile, and nothing is stored.
 * `blocked` when this browser didn't keep it: the person must copy it from the dialog that shows it.
 */
export const replaceMasterKey = (key: string, previous: string): 'kept' | 'blocked' | 'changed' => {
  if (readMasterKey() !== previous)
    return 'changed';
  if (!writeMasterKey(key))
    return 'blocked';
  const before = sessionNow();
  publish({ status: 'signedIn', key: maskKey(key), ...before.status === 'signedIn' && before.freeCredits !== undefined ? { freeCredits: before.freeCredits } : {} });

  return 'kept';
};

/** Ends the session only while `key` is still the stored key, with `notice` saying why. True when it ended. */
export const endSessionFor = (key: string, notice?: SessionNotice): boolean => {
  if (readMasterKey() !== key)
    return false;
  signOut(notice);

  return true;
};

/** Forgets the key and every part of the session. `notice` says why, when it is not the person's own sign-out. */
export const signOut = (notice?: SessionNotice): void => {
  removeMasterKey();
  publish({ status: 'signedOut', ...notice === undefined ? {} : { notice } });
};

/** Ends the session because the API refused `key`, when it is still the stored one: a key replaced since then ends nothing. */
export const refusedKey = (key: string): void => {
  endSessionFor(key, 'expired');
};

/** Drops what this module holds in memory, as a new page load does. For tests. */
export const resetSessionForTests = (): void => {
  current = undefined;
  listeners.clear();
};
