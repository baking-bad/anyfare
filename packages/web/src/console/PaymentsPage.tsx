'use client';

import { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { listKeys, listPayments, type Payment, type PaymentKey, type PaymentState } from './api';
import { PageTitle } from './components/PageTitle';
import { problemText, useConsolePlaces, useRead, type Read } from './context';
import { keyName } from './keys';
import { PaymentHead, PaymentRow } from './PaymentRow';
import { cursorNow, filtersOfQuery, firstPage, hasFilters, hasNewer, hostOf, newer, noFilters, older, pageSize, queryOfFilters, stateChoices, type Cursors, type Filters } from './payments';

const columns = 6;
// How long the service field waits after a key press before it filters
const pauseMs = 500;

interface Page {
  readonly payments: readonly Payment[];
  readonly next: string | null;
}

/** A payments page, read again when the filters or the cursor change, or when asked. A page that comes after another was asked for is dropped. */
const usePayments = (apiUrl: string, filters: Filters, after: string | undefined): readonly [Read<Page>, () => void] => {
  const [read, setRead] = useState<Read<Page>>({ state: 'loading' });
  const [round, setRound] = useState(0);
  const { key, service, state } = filters;
  useEffect(() => {
    let live = true;
    setRead({ state: 'loading' });
    listPayments(apiUrl, { limit: pageSize, after, state, keyId: key, service }).then(
      page => {
        if (live)
          setRead({ state: 'ok', value: page });
      },
      (error: unknown) => {
        if (live)
          setRead({ state: 'failed', error });
      },
    );

    return () => {
      live = false;
    };
  }, [apiUrl, after, key, service, state, round]);

  return [read, () => setRound(count => count + 1)] as const;
};

const Filtering = ({ keys, initialSearch }: { readonly keys: readonly PaymentKey[]; readonly initialSearch: string }) => {
  const { apiUrl } = useSettings();
  const { siteUrl } = useConsolePlaces();
  const [filters, setFilters] = useState<Filters>(() => filtersOfQuery(initialSearch, keys.map(item => item.id)));
  const [cursors, setCursors] = useState<Cursors>(firstPage);
  const [serviceText, setServiceText] = useState(filters.service ?? '');
  const [payments, again] = usePayments(apiUrl, filters, cursorNow(cursors));
  const keyNames = useMemo(() => new Map(keys.map(item => [item.id, keyName(item)] as const)), [keys]);

  // The address holds the filters that passed their checks, and nothing else of the query
  useEffect(() => {
    window.history.replaceState(null, '', `${window.location.pathname}${queryOfFilters(filters)}`);
  }, [filters]);

  const change = (next: Filters): void => {
    setFilters(next);
    setCursors(firstPage);
  };

  // The service field filters on Enter and after a short pause; an empty field clears the filter, text that is no host changes nothing
  const applyService = (text: string): void => {
    const host = text.trim() === '' ? undefined : hostOf(text);
    if (text.trim() !== '' && host === undefined)
      return;
    if (host === filters.service)
      return;
    const { service: _before, ...rest } = filters;
    change(host === undefined ? rest : { ...rest, service: host });
  };
  useEffect(() => {
    const timer = setTimeout(() => applyService(serviceText), pauseMs);

    return () => clearTimeout(timer);
    // The pause starts again with each key press; the filters themselves are read when it ends
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceText]);

  const clear = (): void => {
    setServiceText('');
    change(noFilters);
  };

  const selectKey = (value: string): void => {
    const { key: _before, ...rest } = filters;
    change(value === '' ? rest : { ...rest, key: value });
  };
  const selectState = (value: string): void => {
    const { state: _before, ...rest } = filters;
    change(value === '' ? rest : { ...rest, state: value as PaymentState });
  };
  const typedBad = serviceText.trim() !== '' && hostOf(serviceText) === undefined;
  const loading = payments.state === 'loading';

  return (
    <DataTable
      label="Payments"
      top={(
        <div className="grid-bar">
          <div className="filters">
            <div className="pay-filter">
              <label className="filter-label" htmlFor="f-key">Key</label>
              <select id="f-key" className="input f-key" value={filters.key ?? ''} onChange={event => selectKey(event.target.value)}>
                <option value="">Any key</option>
                {keys.map(item => <option key={item.id} value={item.id}>{keyName(item)}</option>)}
              </select>
            </div>
            <div className="pay-filter">
              <label className="filter-label" htmlFor="f-service">Service</label>
              <div className="search">
                <Icon name="search" />
                <input
                  id="f-service"
                  className="input f-service"
                  placeholder="Host"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={253}
                  value={serviceText}
                  aria-invalid={typedBad ? true : undefined}
                  onChange={event => setServiceText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter')
                      applyService(serviceText);
                  }}
                />
              </div>
            </div>
            <div className="pay-filter">
              <label className="filter-label" htmlFor="f-state">Status</label>
              <select id="f-state" className="input f-state" value={filters.state ?? ''} onChange={event => selectState(event.target.value)}>
                {stateChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            </div>
          </div>
          {hasFilters(filters) || serviceText !== '' ? <Button variant="ghost" size="sm" onClick={clear}><Icon name="x" />Clear filters</Button> : null}
        </div>
      )}
      footer={payments.state === 'ok' && (hasNewer(cursors) || payments.value.next !== null) ? (
        <nav className="pager" aria-label="Pages">
          <span className="small muted num">Page {cursors.seen.length}</span>
          <div className="row">
            <Button variant="secondary" disabled={!hasNewer(cursors)} onClick={() => setCursors(newer(cursors))}>Newer</Button>
            <Button variant="secondary" disabled={payments.value.next === null} onClick={() => payments.value.next !== null && setCursors(older(cursors, payments.value.next))}>Older</Button>
          </div>
        </nav>
      ) : null}
    >
      <PaymentHead chevron />
      <tbody aria-busy={loading}>
        {loading ? [0, 1, 2, 3, 4].map(row => (
          <tr key={row}><td colSpan={columns}><Skeleton shape="block" /></td></tr>
        )) : payments.state === 'failed' ? (
          <tr>
            <td colSpan={columns} className="state-cell">
              <div className="state-inner">
                <ErrorState title="The payments didn't load" action={<Button variant="secondary" size="sm" onClick={again}>Try again</Button>}>{problemText(payments.error)}</ErrorState>
              </div>
            </td>
          </tr>
        ) : payments.state === 'ok' && payments.value.payments.length === 0 ? (
          <tr>
            <td colSpan={columns} className="state-cell">
              <div className="state-inner">
                {hasFilters(filters) ? <EmptyState icon="search" title="No payments match these filters." /> : (
                  <EmptyState icon="receipt" title="No payments yet" action={<Button variant="secondary" href="/keys">Make a key</Button>}>
                    Make a key and call a paid API through Anyfare.
                  </EmptyState>
                )}
              </div>
            </td>
          </tr>
        ) : payments.state === 'ok' ? payments.value.payments.map(payment => (
          <PaymentRow key={payment.id} payment={payment} keyNames={keyNames} siteUrl={siteUrl} chevron />
        )) : null}
      </tbody>
    </DataTable>
  );
};

/**
 * Payments: the account's calls, newest first, 20 to a page, with filters for a key, a service and a status. The
 * filters live in the page's state and in the address (`key`, `service`, `state`), each read back through its own
 * check once the keys are known; the address is read in the browser only, so the server's page holds nothing of it.
 */
export const PaymentsPage = () => {
  const { apiUrl } = useSettings();
  const [keys] = useRead(() => listKeys(apiUrl));
  const [search, setSearch] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSearch(window.location.search);
  }, []);

  return (
    <div className="stack-lg">
      <PageTitle title="Payments" lead="Every paid call of your keys, newest first. A failed call is free. Dates in UTC." />
      {keys.state === 'loading' || search === undefined ? (
        <div className="stack" role="status" aria-label="Loading"><Skeleton shape="block" /><Skeleton shape="block" /></div>
      ) : (
        <Filtering keys={keys.state === 'ok' ? keys.value : []} initialSearch={search} />
      )}
    </div>
  );
};
