'use client';

import { useState } from 'react';

import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { usdOf } from '../format';
import { ConsoleApiError, listKeys, revokeKey, type PaymentKey } from './api';
import { Dialog } from './components/Dialog';
import { PageTitle } from './components/PageTitle';
import { useToast } from './components/Toast';
import { problemText, useRead } from './context';
import { utcDate } from './format';
import { KeyDialog, type KeyDialogMode } from './KeyDialog';
import { KeyMenu } from './KeyMenu';
import { barClass, budgetShare, isExpired, isHot, keyName, keysInOrder } from './keys';

type Open =
  | { readonly kind: 'form'; readonly mode: KeyDialogMode }
  | { readonly kind: 'revoke'; readonly key: PaymentKey };

/** A key's budget for today: a bar and "$0.85 of $5.00". The bar turns yellow above 80 %. */
const Budget = ({ keyRecord }: { readonly keyRecord: PaymentKey }) => {
  const share = budgetShare(keyRecord);

  return (
    <div className="row key-budget">
      <span className="budget" aria-hidden="true"><i className={`${barClass(share)}${isHot(share) ? ' hot' : ''}`} /></span>
      <span className="small num">{usdOf(keyRecord.spent.today)} of {usdOf(keyRecord.dailyBudget)}</span>
    </div>
  );
};

const RevokeDialog = ({ keyRecord, onClose, onRevoked }: { readonly keyRecord: PaymentKey; readonly onClose: () => void; readonly onRevoked: () => void }) => {
  const { apiUrl } = useSettings();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const revoke = async (): Promise<void> => {
    setSending(true);
    setProblem(undefined);
    try {
      await revokeKey(apiUrl, keyRecord.id);
      onRevoked();
      onClose();
    }
    catch (error) {
      setProblem(error instanceof ConsoleApiError && error.status === 404 ? 'This key is not on the account any more.' : problemText(error));
      setSending(false);
    }
  };

  return (
    <Dialog
      title={`Revoke "${keyName(keyRecord)}"?`}
      icon="trash"
      tone="danger"
      {...sending ? {} : { onClose }}
      footer={(
        <>
          <Button variant="outline" disabled={sending} onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={sending} onClick={() => void revoke()}>Revoke key</Button>
        </>
      )}
    >
      <p className="muted">The agent that holds it stops at once. Calls in flight finish. You can&apos;t undo this.</p>
      {problem === undefined ? null : <p className="small field-error" role="alert">{problem}</p>}
    </Dialog>
  );
};

const columns = 6;

/**
 * Keys: the account's payment keys with what each spent today and what it may still spend; a menu to change a key's
 * limits, copy its id or revoke it; New key; and how an agent checks its own key. A new key's secret is shown once, by
 * the dialog that made it (KeyDialog.tsx), and never reaches this page.
 */
export const KeysPage = () => {
  const { apiUrl, payUrl } = useSettings();
  const toast = useToast();
  const [keys, again] = useRead(() => listKeys(apiUrl));
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const [menus, setMenus] = useState(0);
  const now = Date.now();
  const ordered = keys.state === 'ok' ? keysInOrder(keys.value) : [];
  // A menu that is open needs room under the last row, inside the table's box
  const menuOpen = menus > 0;
  const trackMenu = (isOpen: boolean): void => setMenus(count => Math.max(0, count + (isOpen ? 1 : -1)));

  return (
    <div className="stack-lg">
      <PageTitle
        title="Keys"
        lead="One key per agent. A key spends from your balance, within its limits. It can't make keys or raise them."
        actions={<Button size="lg" onClick={() => setOpen({ kind: 'form', mode: { kind: 'new' } })}><Icon name="plus" />New key</Button>}
      />
      {keys.state === 'failed' ? (
        <ErrorState title="The keys didn't load" action={<Button variant="secondary" size="sm" onClick={again}>Try again</Button>}>{problemText(keys.error)}</ErrorState>
      ) : keys.state === 'ok' && keys.value.length === 0 ? (
        <div className="t-wrap">
          <div className="inner">
            <EmptyState icon="key" title="No keys yet" action={<Button onClick={() => setOpen({ kind: 'form', mode: { kind: 'new' } })}><Icon name="plus" />New key</Button>}>
              Make one key for each agent. It pays for calls from your balance, within the limits you set.
            </EmptyState>
          </div>
        </div>
      ) : (
        <div className={menuOpen ? 'keys-table menu-open' : 'keys-table'}>
          <DataTable label="Keys">
            <thead className="stack-head">
              <tr><th>Key</th><th>Today</th><th className="r">Per call</th><th className="r">Allowance left</th><th>Expires</th><th className="r"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody aria-busy={keys.state === 'loading'}>
              {keys.state === 'loading' ? [0, 1, 2].map(row => (
                <tr key={row}><td colSpan={columns}><Skeleton shape="block" /></td></tr>
              )) : ordered.map(item => {
                const revoked = item.revokedAt !== null;
                const expired = isExpired(item, now);

                return (
                  <tr key={item.id} className={revoked ? 'stack-row keys-row quiet' : 'stack-row keys-row'}>
                    <td className="c-name">
                      <div className="key-name">
                        <span className="row-title ellipsis">{keyName(item)}</span>
                        <span className="row-sub mono xs ellipsis">{item.id}</span>
                      </div>
                    </td>
                    <td className="c-today"><Budget keyRecord={item} /></td>
                    <td className="r c-pair" data-label="Per call">{item.maxPrice === null ? <span className="muted">No cap</span> : usdOf(item.maxPrice)}</td>
                    <td className="r c-pair" data-label="Allowance left">
                      {item.allowance === null || item.remaining.allowance === null
                        ? <span className="muted">No cap</span>
                        : <span>{usdOf(item.remaining.allowance)} <span className="muted">of {usdOf(item.allowance)}</span></span>}
                    </td>
                    <td className="small c-pair" data-label="Expires">
                      {item.expiresAt === null ? <span className="muted">Never</span> : <span className="row">{utcDate(item.expiresAt)}{expired && !revoked ? <Badge tone="warning">Expired</Badge> : null}</span>}
                    </td>
                    <td className="r keys-actions c-actions">
                      {revoked ? <Badge>Revoked</Badge> : (
                        <KeyMenu
                          keyRecord={item}
                          onOpen={trackMenu}
                          onLimits={() => setOpen({ kind: 'form', mode: { kind: 'limits', key: item } })}
                          onRevoke={() => setOpen({ kind: 'revoke', key: item })}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}
      <section className="card stack" aria-labelledby="keys-self">
        <h2 id="keys-self" className="card-title">An agent checks its own key</h2>
        <CodeBlock code={`curl ${payUrl}/_/key -H "Authorization: Bearer $ANYFARE_PAYMENT_KEY"`} wrap copyName="Copy the command" />
        <p className="small muted">It answers what is left of the key&apos;s allowance, what is left of its budget for today, and the balance.</p>
      </section>
      {open === undefined ? null : open.kind === 'form' ? (
        <KeyDialog
          key={open.mode.kind === 'new' ? 'new' : open.mode.key.id}
          mode={open.mode}
          onClose={() => setOpen(undefined)}
          onChanged={message => {
            if (message !== undefined)
              toast(message);
            again();
          }}
        />
      ) : (
        <RevokeDialog
          keyRecord={open.key}
          onClose={() => setOpen(undefined)}
          onRevoked={() => {
            toast('Key revoked');
            again();
          }}
        />
      )}
    </div>
  );
};
