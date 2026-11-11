'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { Call } from '../api/types';
import { Icon } from '../components/Icon';
import { Rail } from '../components/Rail';
import { ago, ms, usdOf } from '../format';
import { shortAddress } from './address';

/**
 * The header row of a grid of calls. `showService` is false when every call is to one endpoint, so the
 * service and endpoint column has nothing to tell.
 */
export const CallHead = ({ showService = true }: { readonly showService?: boolean }) => (
  <thead>
    <tr>
      <th>When</th>{showService ? <th>Service and endpoint</th> : null}<th>Paid with</th><th>API paid with</th><th>Buyer</th><th className="r">Amount</th><th>Status</th><th className="r">Time</th><th />
    </tr>
  </thead>
);

/**
 * One call of the grid. The service cell holds the link to the call's receipt, so the keyboard and a screen
 * reader reach it. A click anywhere else in the row opens the same page. `now` is the time the "when"
 * counts from. `fresh` plays the entrance of a call that just arrived. With `showService` false the column
 * is left out, and the link to the receipt is on the "when".
 */
export const CallTableRow = ({ call, now, fresh = false, showService = true }: { readonly call: Call; readonly now: number; readonly fresh?: boolean; readonly showService?: boolean }) => {
  const router = useRouter();
  const href = `/calls/${encodeURIComponent(call.id)}`;
  const paid = call.status === 'paid';

  return (
    <tr
      className={fresh ? 'click fresh' : 'click'}
      onClick={event => {
        if (!(event.target as Element).closest('a'))
          router.push(href);
      }}
    >
      <td className="small muted num">
        {showService ? ago(Date.parse(call.at), now) : <Link prefetch={false} className="when-link" href={href}>{ago(Date.parse(call.at), now)}</Link>}
      </td>
      {showService ? (
        <td>
          <Link prefetch={false} className="call-link" href={href}>
            <span className="small semi call-service ellipsis">{call.service}</span>
            <span className="xs muted mono call-endpoint ellipsis">{call.service}{call.path}</span>
          </Link>
        </td>
      ) : null}
      <td><Rail rail={call.paidWith} /></td>
      <td>{call.apiPaidWith === null ? <span className="muted">-</span> : <Rail rail={call.apiPaidWith} />}</td>
      <td>{call.payer === null ? <span className="muted">-</span> : <span className="mono buyer" title={call.payer}>{shortAddress(call.payer)}</span>}</td>
      <td className="r semi">{paid ? usdOf(call.amount) : '$0'}</td>
      <td>{paid ? <span className="badge success">Paid</span> : <span className="badge danger">{call.apiStatus === null ? 'free' : `${call.apiStatus} · free`}</span>}</td>
      <td className="r small muted">{call.ms === null ? '-' : ms(call.ms)}</td>
      <td className="r"><Icon name="chev" className="chev" /></td>
    </tr>
  );
};
