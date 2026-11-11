'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';

import { paths } from '../api/endpoints';
import type { Call } from '../api/types';
import { CallRow } from '../components/CallRow';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LiveDot } from '../components/LiveDot';
import { useSettings } from '../components/Settings';
import { useCallStream } from '../live/useCallStream';
import { useNow } from '../live/useNow';
import { serviceCallsSize } from './data';

export interface ServiceLiveProps {
  readonly host: string;
  // The last calls to the service, newest first, or null when that read failed
  readonly calls: readonly Call[] | null;
  // The server's clock when it rendered: the "when" of each row counts from it until the browser takes over
  readonly now: number;
}

const rememberedCalls = 500;

/**
 * The last calls to one service. The server renders them from its read. The stream, opened with the
 * service's host as its filter, then puts each new call on top of the list, which keeps its size.
 */
export const ServiceLive = ({ host, calls: firstCalls, now: serverNow }: ServiceLiveProps) => {
  const { apiUrl } = useSettings();
  const now = useNow(serverNow);
  const [calls, setCalls] = useState(firstCalls);
  const [freshId, setFreshId] = useState<string | undefined>(undefined);
  // A call counts once, whatever the stream and the first read both say
  const seen = useRef(new Set((firstCalls ?? []).map(call => call.id)));

  const connected = useCallStream(`${apiUrl}${paths.callStream({ host })}`, useCallback((call: Call) => {
    if (seen.current.has(call.id))
      return;
    seen.current.add(call.id);
    if (seen.current.size > rememberedCalls)
      seen.current.delete(seen.current.values().next().value as string);
    setCalls(current => current === null ? current : [call, ...current].slice(0, serviceCallsSize));
    setFreshId(call.id);
  }, []));

  return (
    <div className="mt-48">
      <div className="row-between svc-live-head">
        <h2 className="h3 row svc-live-title"><LiveDot paused={!connected} /><span>{`Live calls to ${host}`}</span></h2>
        <Link className="link small muted" href={`/calls?service=${encodeURIComponent(host)}`}>All calls</Link>
      </div>
      <div className="well">
        {calls === null ? (
          <div className="rows svc-live-state"><ErrorState title="The last calls didn't load">The Platform API didn&apos;t answer. Reload the page in a moment.</ErrorState></div>
        ) : (
          <div className="rows feed" aria-live="off">
            {calls.length === 0
              ? <EmptyState icon="activity" title="No calls yet">Calls to this service appear here as they are paid.</EmptyState>
              : calls.map(call => <CallRow key={call.id} call={call} now={now} fresh={call.id === freshId} />)}
          </div>
        )}
      </div>
    </div>
  );
};
