import Link from 'next/link';

import type { Call } from '../api/types';
import { ago, ms, usdOf } from '../format';
import { Icon } from './Icon';
import { Rail } from './Rail';

/**
 * One call of a live list: when, the host and path, who paid with what, the amount, the API's time. It
 * links to the call's receipt. A call that wasn't charged shows its status and "free" in place of the amount.
 * `now` is the time the "when" counts from: the server passes its own, and the browser's clock takes over
 * once the page is running. `fresh` plays the entrance of a call that just arrived.
 */
export const CallRow = ({ call, now, fresh = false }: { readonly call: Call; readonly now: number; readonly fresh?: boolean }) => (
  <Link prefetch={false} className={fresh ? 'call new' : 'call'} href={`/calls/${encodeURIComponent(call.id)}`}>
    <span className="when">{ago(Date.parse(call.at), now)}</span>
    <span className="call-main">
      <span className="row-title call-host ellipsis">{call.service}</span>
      <span className="row-sub mono call-path ellipsis">{call.path}</span>
    </span>
    <span className="route">
      <Rail rail={call.paidWith} />
      {call.apiPaidWith === null ? null : <Icon name="arrow" className="arrow" />}
      {call.apiPaidWith === null ? null : <Rail rail={call.apiPaidWith} />}
    </span>
    <span className="amt">
      {call.status === 'paid'
        ? usdOf(call.amount, 3)
        : <span className="badge danger">{call.apiStatus === null ? 'free' : `${call.apiStatus} · free`}</span>}
    </span>
    <span className="ms">{call.ms === null ? '' : ms(call.ms)}</span>
    <Icon name="chev" className="chev" />
  </Link>
);
