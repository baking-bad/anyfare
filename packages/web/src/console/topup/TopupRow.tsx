import { Badge } from '../../components/Badge';
import { RailIcon } from '../../components/Rail';
import { nearTransactionLink } from '../../check/networks';
import { explorerName } from '../../receipt/content';
import type { Topup } from '../api';
import { shortUtc } from '../format';
import { networkName, topupBadge, topupCredits } from './status';

/** The explorer's page of a credited top-up's delivery on NEAR, or nothing. */
export const topupTransactionLink = (topup: Pick<Topup, 'status' | 'transaction'>): string | undefined =>
  topup.status === 'credited' ? nearTransactionLink(topup.transaction) : undefined;

/** The header row of a table of top-ups. `links` adds the column of the explorer links. */
export const TopupHead = ({ links = false }: { readonly links?: boolean }) => (
  <thead className="stack-head">
    <tr><th>Date</th><th>Sent</th><th>Status</th><th className="r">Credits</th>{links ? <th className="r"><span className="sr-only">Transaction</span></th> : null}</tr>
  </thead>
);

/**
 * One top-up of a table (stacked on a phone: what was sent and the Credits, then the date and the badge): the date in
 * UTC, what was sent and on which network, its status as a badge, and the Credits. With `onOpen` the row is a button
 * that opens the top-up, and a credited one links its transaction on the explorer; `current` marks the one on screen.
 */
export const TopupRow = ({ topup, onOpen, current = false }: { readonly topup: Topup; readonly onOpen?: (topup: Topup) => void; readonly current?: boolean }) => {
  const badge = topupBadge(topup.status);
  const credits = topupCredits(topup);
  const sent = (
    <span className="topup-sent">
      <RailIcon rail={topup.network} token={topup.token} size={24} />
      <span>{topup.amount} {topup.token} <span className="muted">on {networkName(topup.network)}</span></span>
    </span>
  );
  const link = onOpen === undefined ? undefined : topupTransactionLink(topup);

  return (
    <tr className={['stack-row topup-row', onOpen === undefined ? '' : 'click', current ? 'current' : ''].filter(Boolean).join(' ')} aria-current={current ? 'true' : undefined}>
      <td className="small muted num c-date">{shortUtc(topup.createdAt)}</td>
      <td className="small semi c-sent">
        {onOpen === undefined ? sent : (
          <button type="button" className="row-link topup-open" onClick={() => onOpen(topup)}>
            {sent}
            <span className="sr-only">, open this top-up</span>
          </button>
        )}
      </td>
      <td className="c-status"><span title={topup.message ?? undefined}><Badge tone={badge.tone}>{badge.label}</Badge></span></td>
      <td className="r semi c-amount">
        {credits === null ? <span className="muted">-</span> : <span className={credits.tone === 'added' ? 'plus' : 'muted'}>{credits.text}</span>}
      </td>
      {onOpen === undefined ? null : (
        <td className="r c-link">
          {link === undefined ? null : <a className="link xs muted topup-tx" href={link} target="_blank" rel="noopener noreferrer">{explorerName(link)}<span className="sr-only">: the transaction, opens in a new tab</span></a>}
        </td>
      )}
    </tr>
  );
};
