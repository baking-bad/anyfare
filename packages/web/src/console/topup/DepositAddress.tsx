import { RailIcon } from '../../components/Rail';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { QrCode } from './QrCode';
import { networkName } from './status';

/**
 * Where to send: the QR code, the address in full (it wraps, it is never cut) and its copy button, and the memo when
 * there is one. The QR code, the box and the button all get `address` itself, the API's string for the top-up on
 * screen, and nothing else.
 */
export const DepositAddress = ({ address, memo, token, network }: {
  readonly address: string;
  readonly memo: string | null;
  readonly token: string;
  readonly network: string;
}) => (
  <div className="stack deposit">
    <div className="deposit-main">
      <QrCode value={address} />
      <div className="stack deposit-text">
        <span className="label row deposit-label"><RailIcon rail={network} token={token} size={24} />Deposit address, {token} on {networkName(network)}</span>
        <code className="addr-box">{address}</code>
        <CopyButton text={address} label="Copy address" withIcon variant="secondary" size="lg" className="deposit-copy" />
      </div>
    </div>
    {memo === null ? null : (
      <div className="stack deposit-memo">
        <span className="label">Memo</span>
        <code className="addr-box">{memo}</code>
        <CopyButton text={memo} label="Copy memo" withIcon variant="secondary" size="lg" className="deposit-copy" />
        <div className="alert danger" role="alert">
          <Icon name="alert" />
          <div className="stack"><span>Send with this memo. A transfer without it can&apos;t be matched.</span></div>
        </div>
      </div>
    )}
  </div>
);
