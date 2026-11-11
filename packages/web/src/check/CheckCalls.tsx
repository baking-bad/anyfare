'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { listCalls } from '../api/endpoints';
import { createReader, type ApiResult } from '../api/reader';
import type { CallsPage } from '../api/types';
import { CallHead, CallTableRow } from '../calls/CallTableRow';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Pager } from '../components/Pager';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { callsSize, checkAddress, parseCheckParams, type CheckParams } from './content';

const skeletonRows = [0, 1, 2, 3];


/**
 * The last calls to the endpoint, 10 a page. The server renders the page the URL names, and each page is a
 * link to it, so a shared link and a browser without scripts work. With scripts a click reads that page
 * straight from the public API, shows a loading state, and rewrites the address with `&page=`. It makes no
 * navigation, so the link is not checked again.
 */
export const CheckCalls = ({ host, path, params, calls: first, page: firstPage, now }: {
  readonly host: string;
  // The URL's state, for the links of the pages
  readonly params: CheckParams;
  readonly path: string;
  readonly calls: ApiResult<CallsPage>;
  readonly page: number;
  // The server's clock when it rendered
  readonly now: number;
}) => {
  const { apiUrl } = useSettings();
  const [calls, setCalls] = useState(first);
  const [page, setPage] = useState(firstPage);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setCalls(first);
    setPage(firstPage);
  }, [first, firstPage]);

  const go = useCallback((next: number): void => {
    const id = request.current + 1;
    request.current = id;
    setPage(next);
    setLoading(true);
    // Built from the address as it is now, so a tab or a period chosen since the page loaded stays
    window.history.replaceState(null, '', checkAddress({ ...parseCheckParams(new URLSearchParams(window.location.search)), page: next }));
    void listCalls(createReader({ apiUrl }), { host, endpoint: path, size: callsSize, page: next }).then(result => {
      if (id !== request.current)
        return;
      setCalls(result);
      setLoading(false);
    });
  }, [apiUrl, host, path]);

  // The page mounts again after a visit to the Agent view: the address may hold a page the server's calls are not for
  useEffect(() => {
    const now = parseCheckParams(new URLSearchParams(window.location.search)).page;
    if (now !== firstPage)
      go(now);
    // Only when the page mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DataTable
      label="Last calls"
      title={<h2 className="well-heading">Last calls</h2>}
      footer={calls.ok && calls.value.total > 0 ? (
        <Pager page={page} size={calls.value.size} total={calls.value.total} capped={calls.value.totalCapped} onPage={go} hrefFor={next => checkAddress({ ...params, page: next })} />
      ) : null}
    >
      <CallHead showService={false} />
      <tbody aria-busy={loading}>
        {loading ? skeletonRows.map(row => (
          <tr key={row}><td colSpan={8}><Skeleton shape="block" /></td></tr>
        )) : !calls.ok ? (
          <tr>
            <td colSpan={8} className="state-cell"><div className="state-inner"><ErrorState title="The calls didn't load">The Platform API didn&apos;t answer. Reload the page in a moment.</ErrorState></div></td>
          </tr>
        ) : calls.value.calls.length === 0 ? (
          <tr>
            <td colSpan={8} className="state-cell"><div className="state-inner"><EmptyState icon="activity" title="No calls through Anyfare yet.">Yours can be the first.</EmptyState></div></td>
          </tr>
        ) : calls.value.calls.map(call => <CallTableRow key={call.id} call={call} now={now} showService={false} />)}
      </tbody>
    </DataTable>
  );
};
