import { Badge } from '../components/Badge';
import { Icon } from '../components/Icon';
import { shortUtc } from './format';
import type { Payment } from './api';
import { paymentAmount, paymentBadge, receiptUrl } from './payments';

/** The header row of a table of payments. `chevron` adds the column of the arrow that marks a row you can open. */
export const PaymentHead = ({ chevron = false }: { readonly chevron?: boolean }) => (
  <thead className="stack-head">
    <tr><th>Date</th><th>What</th><th>Key</th><th>Status</th><th className="r">Amount</th>{chevron ? <th /> : null}</tr>
  </thead>
);

/**
 * One payment of a table (stacked on a phone: host and amount, path, then date, key and status). A finished call's row is a link to its public receipt, in a new tab; a call in flight has
 * none. `keyNames` maps a key's ID to the name it goes by: a key that isn't in it reads as a dash. The host and the
 * path come from outside, so they are text, cut with an ellipsis.
 */
export const PaymentRow = ({ payment, keyNames, siteUrl, chevron = false }: {
  readonly payment: Payment;
  readonly keyNames: ReadonlyMap<string, string>;
  readonly siteUrl: string;
  readonly chevron?: boolean;
}) => {
  const href = receiptUrl(siteUrl, payment);
  const badge = paymentBadge(payment);
  const amount = paymentAmount(payment);
  const keyName = payment.keyId === null ? undefined : keyNames.get(payment.keyId);
  const host = <span className="small semi ellipsis pay-host">{payment.targetHost}</span>;

  return (
    <tr className={href === undefined ? 'stack-row pay-row' : 'stack-row pay-row click'}>
      <td className="small muted num c-date">{shortUtc(payment.createdAt)}</td>
      <td className="c-what">
        <div className="pay-what">
          {href === undefined ? host : (
            <a className="row-link pay-link" href={href} target="_blank" rel="noopener">
              {host}
              <span className="sr-only">Receipt, opens in a new tab</span>
            </a>
          )}
          <span className="xs muted mono ellipsis">{payment.targetPath}</span>
        </div>
      </td>
      <td className="small c-key">{keyName === undefined ? <span className="muted">-</span> : <span className="ellipsis pay-key">{keyName}</span>}</td>
      <td className="c-status"><Badge tone={badge.tone}>{badge.text}</Badge></td>
      <td className={amount.muted ? 'r semi muted c-amount' : 'r semi c-amount'}>{amount.text}</td>
      {chevron ? <td className="r c-chev">{href === undefined ? null : <Icon name="chev" className="chev" />}</td> : null}
    </tr>
  );
};
