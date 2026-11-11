'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';

import { paths } from '../api/endpoints';
import type { Call } from '../api/types';
import { CallRow } from '../components/CallRow';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LiveDot } from '../components/LiveDot';
import { useSettings } from '../components/Settings';
import { count, usd } from '../format';
import { useCallStream } from '../live/useCallStream';
import { useNow } from '../live/useNow';
import { changeOf, formatChange } from './change';
import { lastCallsSize } from './data';

export interface LiveCallsProps {
  // The last calls, newest first, or null when that read failed
  readonly calls: readonly Call[] | null;
  // The live numbers, or null when that read failed
  readonly numbers: {
    // What was paid in the last 24 hours, and in the 24 hours before: USD decimal strings
    readonly volume: string;
    readonly volumeBefore: string;
    readonly callsToday: number;
  } | null;
  // The server's clock when it rendered: the "when" of each row counts from it until the browser takes over
  readonly now: number;
}

const rememberedCalls = 500;

/**
 * The live part of the home page: what was paid in the last 24 hours, today's paid calls, and the last
 * calls. The server renders them from its reads. The stream then puts each new call on top of the list,
 * which keeps its size, and a paid call grows the numbers.
 */
export const LiveCalls = ({ calls: firstCalls, numbers, now: serverNow }: LiveCallsProps) => {
  const { apiUrl } = useSettings();
  const now = useNow(serverNow);
  const [calls, setCalls] = useState(firstCalls);
  const [freshId, setFreshId] = useState<string | undefined>(undefined);
  const [volume, setVolume] = useState(Number(numbers?.volume ?? 0));
  const [callsToday, setCallsToday] = useState(numbers?.callsToday ?? 0);
  // A call counts once, whatever the stream and the first read both say
  const seen = useRef(new Set((firstCalls ?? []).map(call => call.id)));

  const connected = useCallStream(`${apiUrl}${paths.callStream()}`, useCallback((call: Call) => {
    if (seen.current.has(call.id))
      return;
    seen.current.add(call.id);
    if (seen.current.size > rememberedCalls)
      seen.current.delete(seen.current.values().next().value as string);
    setCalls(current => current === null ? current : [call, ...current].slice(0, lastCallsSize));
    setFreshId(call.id);
    const amount = Number(call.amount);
    if (call.status === 'paid' && numbers !== null && Number.isFinite(amount)) {
      setVolume(current => current + amount);
      setCallsToday(current => current + 1);
    }
  }, [numbers]));

  const change = numbers === null ? null : changeOf(String(volume), numbers.volumeBefore);

  return (
    <section className="band wash">
      <div className="container ruled live-section">
        <p className="row small muted live-line">
          <LiveDot paused={!connected} />
          Live. Calls paid through Anyfare right now. <Link className="link" href="/calls">See every call</Link>
        </p>
        <Card raised large>
          {numbers === null ? (
            <div className="live-head"><ErrorState title="The numbers didn't load">The Platform API didn&apos;t answer. Reload the page in a moment.</ErrorState></div>
          ) : (
            <div className="row-between live-head">
              <div className="stack live-total">
                <span className="muted small">Paid through Anyfare in the last 24 hours</span>
                <span className="balance">{usd(volume, 2)}</span>
              </div>
              <div className="row">
                {change === null ? null : (
                  <span className={change < 0 ? 'pill-value info' : 'pill-value up'} title={`${formatChange(change)} against the 24 hours before`}>
                    {change < 0 ? '▼' : '▲'} {formatChange(change).replace(/^[+-]/, '')}
                  </span>
                )}
                <span className="small muted">{count(callsToday)} paid calls today</span>
              </div>
            </div>
          )}
          <div className="well">
            <div className="well-title">
              <span>Last calls</span>
              <span className="row xs muted route-legend">Buyer paid with <span className="legend-arrow" aria-hidden="true">→</span> API was paid with</span>
            </div>
            {calls === null ? (
              <div className="rows live-error"><ErrorState title="The last calls didn't load">The Platform API didn&apos;t answer. Reload the page in a moment.</ErrorState></div>
            ) : (
              <div className="rows feed" aria-live="off">
                {calls.length === 0
                  ? <EmptyState icon="activity" title="No calls yet">Calls appear here as they are paid.</EmptyState>
                  : calls.map(call => <CallRow key={call.id} call={call} now={now} fresh={call.id === freshId} />)}
              </div>
            )}
          </div>
        </Card>
      </div>
    </section>
  );
};
