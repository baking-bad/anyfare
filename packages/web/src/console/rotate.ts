import { checkStoredKey, ConsoleApiError, RefusedTargetError, rotateMasterKey } from './api';
import { problemText } from './context';
import { endSessionFor, readMasterKey, replaceMasterKey, signOut } from './session';

// The rotation of the master key, and what to say when its answer doesn't come. The API stops the old key the moment
// it rotates, so an answer that is lost, late, refused or unreadable may leave this browser with a dead key: the console
// doesn't guess, it asks the API whether the key that sent the rotation still works. The session may change while the
// request runs (a sign-out, another account): every change the rotation makes to it is made only while the stored key
// is still the one that sent the request.

/**
 * - `rotated`: the new key is stored for the session that asked (`kept`), before anything shows it; when this browser
 *   didn't keep it, that session has ended. `masterKey` is for the one dialog that shows it.
 * - `rotatedElsewhere`: the new key came after the session ended or changed: it is stored nowhere, only shown once.
 * - `notRotated`: the old key is the one, and it works; `problem` says why the rotation didn't happen.
 * - `lost`: the key was changed but the new one never arrived; the session has ended, and the sign-in view says so.
 * - `unknown`: the console can't tell whether the key was rotated; the session stays.
 * - `changed`: the rotation failed after the session had ended or changed; nothing is said to the session there is now.
 * - `signedOut`: there was no key to rotate with.
 */
export type RotateOutcome =
  | { readonly kind: 'rotated'; readonly masterKey: string; readonly kept: boolean }
  | { readonly kind: 'rotatedElsewhere'; readonly masterKey: string }
  | { readonly kind: 'notRotated'; readonly problem: string }
  | { readonly kind: 'lost' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'signedOut' };

/** Whether a failed rotation may have rotated the key all the same: no answer, a late one, a 5xx, or one that can't be read. */
export const mayHaveRotated = (error: unknown): boolean =>
  !(error instanceof ConsoleApiError) || error.status === 0 || error.status >= 500 || error.code === 'unexpected_answer';

export const notRotatedText = 'Your master key is the one it was, and it still works.';
export const unknownText = 'The Anyfare API didn\'t answer, so the console can\'t tell whether the master key was rotated. Try signing in again in a moment.';

// After a failed rotation: ask whether `previous`, the key that sent it, still works, and act only on its session
const afterFailure = async (apiUrl: string, previous: string, error: unknown): Promise<RotateOutcome> => {
  let state: 'works' | 'refused';
  try {
    state = await checkStoredKey(apiUrl, previous);
  }
  catch {
    return readMasterKey() === previous ? { kind: 'unknown' } : { kind: 'changed' };
  }
  if (state === 'refused')
    return endSessionFor(previous, 'lost') ? { kind: 'lost' } : { kind: 'changed' };
  if (readMasterKey() !== previous)
    return { kind: 'changed' };

  return { kind: 'notRotated', problem: mayHaveRotated(error) ? `The Anyfare API didn't rotate it. ${notRotatedText}` : `${problemText(error)} ${notRotatedText}` };
};

/** Rotates the master key, stores the new one before it is shown, and, when the answer isn't one, finds out what happened. */
export const rotateAndCheck = async (apiUrl: string): Promise<RotateOutcome> => {
  const previous = readMasterKey();
  if (previous === undefined) {
    signOut('expired');

    return { kind: 'signedOut' };
  }
  let masterKey: string;
  try {
    masterKey = await rotateMasterKey(apiUrl, previous);
  }
  catch (error) {
    // A request that was never sent rotated nothing; any other failure, whatever its status, is checked
    return error instanceof RefusedTargetError ? { kind: 'notRotated', problem: `${problemText(error)} ${notRotatedText}` } : afterFailure(apiUrl, previous, error);
  }
  // The old key stopped at once: the new one is stored before it is shown, and only for the session that asked
  const stored = replaceMasterKey(masterKey, previous);
  if (stored === 'changed')
    return { kind: 'rotatedElsewhere', masterKey };
  // This browser didn't keep it: the session's key is dead, so the session ends, and the dialog says so
  if (stored === 'blocked')
    endSessionFor(previous);

  return { kind: 'rotated', masterKey, kept: stored === 'kept' };
};

/** Runs `run` one at a time: a call while one runs gets the running one's promise, and starts nothing. */
export const oneAtATime = <TResult>(run: () => Promise<TResult>): (() => Promise<TResult>) => {
  let running: Promise<TResult> | undefined;

  return () => {
    running ??= run().finally(() => {
      running = undefined;
    });

    return running;
  };
};
