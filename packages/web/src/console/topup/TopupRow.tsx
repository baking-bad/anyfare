import { Badge } from '../../components/Badge';
import type { Topup } from '../api';
import { shortUtc } from '../format';
import { networkName, topupBadge, topupCredits } from './status';

/** The header row of a table of top-ups. */
export const TopupHead = () => (
  <thead className="stack-head">
    <tr><th>Date</th><th>Sent</th><th>Status</th><th className="r">Credits</th></tr>
  </thead>
);

/** One top-up of a table (stacked on a phone: what was sent and the Credits, then the date and the badge): the date in UTC, what was sent and on which network, its status as a badge, and the Credits. */
export const TopupRow = ({ topup }: { readonly topup: Topup }) => {
  const badge = topupBadge(topup.status);
  const credits = topupCredits(topup);

  return (
    <tr className="stack-row topup-row">
      <td className="small muted num c-date">{shortUtc(topup.createdAt)}</td>
      <td className="small semi c-sent">{topup.amount} {topup.token} <span className="muted">on {networkName(topup.network)}</span></td>
      <td className="c-status"><span title={topup.message ?? undefined}><Badge tone={badge.tone}>{badge.label}</Badge></span></td>
      <td className="r semi c-amount">
        {credits === null ? <span className="muted">-</span> : <span className={credits.tone === 'added' ? 'plus' : 'muted'}>{credits.text}</span>}
      </td>
    </tr>
  );
};
