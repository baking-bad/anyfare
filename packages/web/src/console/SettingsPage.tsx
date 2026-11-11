'use client';

import { useState } from 'react';

import { Button } from '../components/Button';
import { CopyButton } from '../components/CopyButton';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { Skeleton } from '../components/Skeleton';
import { Dialog } from './components/Dialog';
import { PageTitle } from './components/PageTitle';
import { problemText, useConsoleData } from './context';
import { utcDateTime } from './format';
import { unknownText } from './rotate';
import { useRotation } from './Rotation';
import { longMasked, signOut, useSession } from './session';

/**
 * Settings: the master key, masked, and its rotation; the account's id and when it was made; and Sign out. The
 * rotation runs above the pages (Rotation.tsx), which stores the new key and shows it, even when this page is gone by then.
 */
export const SettingsPage = () => {
  const session = useSession();
  const { account, readAccountAgain } = useConsoleData();
  const { rotate, running } = useRotation();
  const [confirming, setConfirming] = useState(false);
  const [rotateProblem, setRotateProblem] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);

  if (session.status !== 'signedIn')
    return null;

  // The question closes, and the rotation's own modal covers the console until the answer
  const start = async (): Promise<void> => {
    setConfirming(false);
    setRotateProblem(undefined);
    const result = await rotate();
    // A rotated key shows in the rotation's dialog; a lost one has ended the session, and the sign-in view says why
    if (result.kind === 'notRotated')
      setRotateProblem({ title: 'The master key was not rotated', text: result.problem });
    else if (result.kind === 'unknown')
      setRotateProblem({ title: 'The console can\'t tell whether the master key was rotated', text: unknownText });
  };

  return (
    <div className="stack-lg">
      <PageTitle title="Settings" />
      <div className="settings-col stack-lg">
        <section className="card stack" aria-labelledby="settings-key">
          <h2 id="settings-key" className="card-title">Master key</h2>
          <p className="small muted">It manages the account: keys, balance, top-ups. It can&apos;t pay for calls. Keep it with you, not in an agent.</p>
          <div className="key-row">
            <span className="sr-only">The master key, masked:</span>
            <code className="masked-key">{longMasked(session.key)}</code>
            <Button variant="secondary" disabled={running} onClick={() => setConfirming(true)}><Icon name="refresh" />Rotate</Button>
          </div>
          {rotateProblem === undefined ? null : <ErrorState title={rotateProblem.title}>{rotateProblem.text}</ErrorState>}
        </section>
        <div className="alert warning">
          <Icon name="alert" />
          <div className="stack tight">
            <span className="t">A lost master key can&apos;t be recovered</span>
            <span>There is no email on the account. Keep a copy somewhere safe.</span>
          </div>
        </div>
        <section className="card stack" aria-labelledby="settings-account">
          <h2 id="settings-account" className="card-title">Account</h2>
          {account.state === 'loading' ? (
            <div className="stack" role="status" aria-label="Reading the account"><Skeleton width="md" /><Skeleton width="md" /></div>
          ) : account.state === 'failed' ? (
            <ErrorState title="The account didn't load" action={<Button variant="secondary" size="sm" onClick={readAccountAgain}>Try again</Button>}>{problemText(account.error)}</ErrorState>
          ) : (
            <dl className="kv left settings-kv">
              <dt>Account id</dt>
              <dd className="settings-id">
                <code>{account.value.id}</code>
                <CopyButton text={account.value.id} label="Copy the account id" variant="ghost" iconOnly />
              </dd>
              <dt>Created</dt>
              <dd>{utcDateTime(account.value.createdAt)}</dd>
            </dl>
          )}
        </section>
        <section className="card stack" aria-labelledby="settings-out">
          <h2 id="settings-out" className="card-title">Sign out</h2>
          <p className="small muted">This browser tab forgets the master key. You sign in again by pasting it.</p>
          <div className="row"><Button variant="outline" onClick={() => signOut()}><Icon name="arrow" />Sign out</Button></div>
        </section>
      </div>
      {confirming ? (
        <Dialog
          title="Rotate the master key?"
          icon="refresh"
          tone="danger"
          onClose={() => setConfirming(false)}
          footer={(
            <>
              <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => void start()}>Rotate</Button>
            </>
          )}
        >
          <p className="muted">You get a new master key. The old one stops at once. Payment keys keep working.</p>
        </Dialog>
      ) : null}
    </div>
  );
};
