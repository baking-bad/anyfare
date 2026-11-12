'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { useSettings } from '../components/Settings';
import { Spinner } from '../components/Spinner';
import { ThemeMenu } from '../components/ThemeMenu';
import { ViewSwitch } from '../components/ViewSwitch';
import { useView } from '../components/view';
import { usd } from '../format';
import { AgentPanel } from './AgentPanel';
import { checkMasterKey, ConsoleApiError, createAccount } from './api';
import { problemText, useConsolePlaces, waitText } from './context';
import { isPositive } from './format';
import { SiteLogo } from './components/SiteLogo';
import { NewKeyDialog } from './NewKeyDialog';
import { expiredNotice, lostNotice, signIn, type SessionNotice } from './session';

/** What a failed check of a pasted key says. Always text. */
export const signInProblem = (error: unknown): string => {
  if (error instanceof ConsoleApiError && error.status === 401)
    return error.code === 'wrong_key_type' ? 'This is a payment key. Paste the master key: it starts with afm_live_.' : 'This master key doesn\'t work. Check that you pasted all of it.';
  if (error instanceof ConsoleApiError && error.status === 429)
    return error.retryAfter === undefined ? 'Too many tries. Wait a minute and try again.' : `Too many tries. Wait ${waitText(error.retryAfter)} and try again.`;

  return problemText(error);
};

/** What a failed sign-up says. Always text. */
export const signUpProblem = (error: unknown): string => {
  if (error instanceof ConsoleApiError && error.status === 429)
    return error.retryAfter === undefined ? 'Too many accounts were made just now. Try again later.' : `Too many accounts were made just now. Try again in ${waitText(error.retryAfter)}.`;

  return problemText(error);
};

const blockedStorage = 'This browser blocks storage for this site, so the console can\'t keep you signed in. Allow it and try again.';
const blockedNewKey = 'This browser blocks storage for this site, so the console can\'t keep you signed in. Copy the key now and sign in with it where storage is allowed.';

interface Created {
  readonly masterKey: string;
  readonly freeCredits: string;
}

/**
 * The sign-in view. It shows in place of any console page while no one is signed in, on that page's own address, and
 * that page shows once the person signs in. `amount` is a top-up link's amount, and `amountUnused` says the link had one
 * that was not used; `notice` says the stored key stopped
 * working. There is no form: nothing here can post to the site, even before the page's script runs.
 */
export const SignIn = ({ amount, amountUnused = false, notice }: { readonly amount?: number | undefined; readonly amountUnused?: boolean; readonly notice?: SessionNotice | undefined }) => {
  const { apiUrl } = useSettings();
  const { siteUrl } = useConsolePlaces();
  const view = useView();
  const field = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<{ readonly where: 'create' | 'paste'; readonly text: string } | undefined>(undefined);
  // The new key, from the sign-up's answer to Continue. Nothing else holds it.
  const [created, setCreated] = useState<Created | undefined>(undefined);
  const [keepProblem, setKeepProblem] = useState<string | undefined>(undefined);

  // A page that is left drops the new key with it, at once, so a page frozen into the back-forward cache holds none
  useEffect(() => {
    if (created === undefined)
      return undefined;
    const drop = (): void => flushSync(() => setCreated(undefined));
    window.addEventListener('pagehide', drop);

    return () => window.removeEventListener('pagehide', drop);
  }, [created]);

  const create = async (): Promise<void> => {
    // The button is disabled while the request runs; this holds a second click that comes before it is
    if (busy.current)
      return;
    busy.current = true;
    setCreating(true);
    setProblem(undefined);
    try {
      const account = await createAccount(apiUrl);
      setCreated({ masterKey: account.masterKey, freeCredits: account.freeCredits });
    }
    catch (error) {
      setProblem({ where: 'create', text: signUpProblem(error) });
    }
    finally {
      busy.current = false;
      setCreating(false);
    }
  };

  const continueSignedIn = (): void => {
    if (created === undefined)
      return;
    const { masterKey, freeCredits } = created;
    if (!signIn(masterKey, isPositive(freeCredits) ? { freeCredits } : {})) {
      setKeepProblem(blockedNewKey);

      return;
    }
    setCreated(undefined);
  };

  // Closes the dialog of a key this browser didn't keep: the key goes with it, and the person stays signed out
  const closeUnkept = (): void => {
    setCreated(undefined);
    setKeepProblem(undefined);
  };

  const paste = async (): Promise<void> => {
    const input = field.current;
    if (input === null || busy.current)
      return;
    const key = input.value.trim();
    // The field is cleared after every try: the key stays only as long as the check runs
    input.value = '';
    if (key === '') {
      setProblem({ where: 'paste', text: 'Paste the master key first.' });
      input.focus();

      return;
    }
    busy.current = true;
    setChecking(true);
    setProblem(undefined);
    try {
      await checkMasterKey(apiUrl, key);
      if (!signIn(key))
        setProblem({ where: 'paste', text: blockedStorage });
    }
    catch (error) {
      setProblem({ where: 'paste', text: signInProblem(error) });
      input.focus();
    }
    finally {
      busy.current = false;
      setChecking(false);
    }
  };

  return (
    <div className="canvas">
      <header className="container signin-top">
        <SiteLogo siteUrl={siteUrl} />
        <div className="header-end">
          <ViewSwitch className="hide-sm" />
          <ThemeMenu />
        </div>
      </header>
      {view === 'agent' ? <main id="main" className="signin-agent"><AgentPanel page="signin" /></main> : (
        <main id="main" className="auth-col">
          <div className="auth-head">
            <h1 className="page-title">Sign in or create an account</h1>
            <p className="muted">No email. No password. One master key.</p>
            {amount === undefined ? null : <p className="small">After you sign in, Top up opens with <b>{usd(amount)}</b> from the link.</p>}
          </div>
          {amountUnused ? (
            <div className="alert warning" role="status">
              <Icon name="alert" />
              <div className="stack tight">
                <span className="t">The amount in the link was not used</span>
                <span>It wasn&apos;t a number from $1 to $1,000. After you sign in, enter the amount on Top up yourself.</span>
              </div>
            </div>
          ) : null}
          {notice === 'expired' ? (
            <div className="alert warning" role="alert">
              <Icon name="alert" />
              <div className="stack"><span className="t">{expiredNotice}</span></div>
            </div>
          ) : notice === 'lost' ? (
            <div className="alert warning" role="alert">
              <Icon name="alert" />
              <div className="stack tight"><span className="t">{lostNotice.title}</span><span>{lostNotice.text}</span></div>
            </div>
          ) : null}
          <div className="stack">
            <button type="button" className="card raised clickable choice" onClick={() => void create()} disabled={creating} aria-busy={creating}>
              <span className="tile brand">{creating ? <Spinner label="Making the account" /> : <Icon name="key" />}</span>
              <span className="choice-text">
                <span className="row"><span className="row-title">Create an account</span><Badge tone="brand">Recommended</Badge></span>
                <span className="small muted">One click. You get a master key and $0.10 of free Credits to try.</span>
              </span>
            </button>
            {problem?.where === 'create' ? <p className="small field-error" role="alert">{problem.text}</p> : null}
          </div>
          <div className="card raised choice paste">
            <div className="choice-head">
              <span className="tile"><Icon name="user" /></span>
              <span className="choice-text">
                <span className="row-title">Paste a master key</span>
                <span className="small muted" id="key-hint">It starts with afm_live_. It stays in this browser tab only.</span>
              </span>
            </div>
            <div className="key-row">
              <input
                ref={field}
                className="input mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                placeholder="afm_live_…"
                aria-label="Master key"
                aria-describedby={problem?.where === 'paste' ? 'key-hint key-problem' : 'key-hint'}
                aria-invalid={problem?.where === 'paste' ? true : undefined}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void paste();
                  }
                }}
              />
              <Button size="lg" loading={checking} onClick={() => void paste()}>Sign in</Button>
            </div>
            {problem?.where === 'paste' ? <p id="key-problem" className="small field-error" role="alert">{problem.text}</p> : null}
          </div>
          <p className="xs muted auth-foot">A lost master key can&apos;t be recovered. There is no email on the account.</p>
        </main>
      )}
      {created === undefined ? null : (
        <NewKeyDialog
          title="Your account is ready"
          lead="This is your master key. We show it once. A lost master key can't be recovered."
          masterKey={created.masterKey}
          // A browser that didn't keep the key: the person may close the dialog, and stays signed out
          {...keepProblem === undefined ? {} : { problem: keepProblem, onClose: closeUnkept }}
          onContinue={continueSignedIn}
        />
      )}
    </div>
  );
};
