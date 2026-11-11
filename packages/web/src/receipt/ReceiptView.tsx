import type { ReactNode } from 'react';

import type { Receipt } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { CopyButton } from '../components/CopyButton';
import { Icon } from '../components/Icon';
import { highlightJson, jsonText } from '../components/Json';
import { Rail } from '../components/Rail';
import { Tabs } from '../components/Tabs';
import { ms, usdOf } from '../format';
import {
  callLine, creditsLine, explorerName, noApiLine, paidAmount, receiptEyebrow, safeExplorerUrl, seconds, shortHash, sideLine, statusWords, stepTime, stepWords, utcMoment,
} from './content';

const dash = '-';

const serviceHref = (host: string): string => `/services/${encodeURIComponent(host)}`;

/** A transaction line: a link to the explorer when the API gave a URL, the short hash alone when it didn't. */
const Transaction = ({ hash, explorerUrl }: { readonly hash: string; readonly explorerUrl: string | null }) => {
  const url = safeExplorerUrl(explorerUrl);
  const text = `Transaction ${shortHash(hash)}`;

  return url === undefined
    ? <span className="small mono">{text}</span>
    : <a className="link small break" href={url} target="_blank" rel="noopener noreferrer">{`${text} on ${explorerName(url)}`}</a>;
};

const BuyerBox = ({ receipt }: { readonly receipt: Receipt }) => {
  const { buyer, status } = receipt;
  const credits = buyer.paidWith === 'credits';
  const paid = status === 'paid';

  return (
    <div className="node">
      <span className="xs muted semi">{paid ? 'The buyer paid' : 'The buyer was not charged'}</span>
      <span className="h4">{sideLine(buyer)}</span>
      {credits || buyer.payer === null ? null : <span className="mono small break">{buyer.payer}</span>}
      {credits
        ? paid ? <span className="small muted">{creditsLine}</span> : null
        : buyer.transaction === null ? null : <Transaction hash={buyer.transaction} explorerUrl={buyer.explorerUrl} />}
    </div>
  );
};

const Leg = ({ paidWith, asset }: { readonly paidWith: string; readonly asset: string | null }) => (
  <span className="leg">
    <Rail rail={paidWith} />
    {paidWith === 'credits' || asset === null ? null : <b>{asset}</b>}
  </span>
);

const RouteBox = ({ receipt }: { readonly receipt: Receipt }) => {
  const { buyer, api, fee } = receipt;

  return (
    <div className="node us">
      <span className="xs muted semi">Anyfare</span>
      <div className="route-big">
        <Leg paidWith={buyer.paidWith} asset={buyer.asset} />
        {api === null ? null : <Icon name="arrow" />}
        {api === null ? null : <Leg paidWith={api.paidWith} asset={api.asset} />}
      </div>
      {fee === null ? null : <span className="small muted">Fee {usdOf(fee)}</span>}
    </div>
  );
};

const ApiBox = ({ receipt }: { readonly receipt: Receipt }) => {
  const { api, service } = receipt;
  if (api === null) {
    return (
      <div className="node">
        <span className="xs muted semi">We paid the API</span>
        <span className="small muted">{noApiLine}</span>
      </div>
    );
  }

  return (
    <div className="node">
      <span className="xs muted semi">We paid the API</span>
      <span className="h4">{sideLine(api)}</span>
      <span className="mono small ellipsis">{service}</span>
      {api.transaction === null ? null : <Transaction hash={api.transaction} explorerUrl={api.explorerUrl} />}
    </div>
  );
};

const Detail = ({ label, wide = false, children }: { readonly label: string; readonly wide?: boolean; readonly children: ReactNode }) => (
  <div className={wide ? 'wide' : undefined}>
    <span className="small muted">{label}</span>
    <div>{children}</div>
  </div>
);

const Details = ({ receipt }: { readonly receipt: Receipt }) => (
  <div className="detail-grid">
    <Detail label="Call" wide><div className="mono small break">{callLine(receipt)}</div></Detail>
    <Detail label="Service"><a className="link break" href={serviceHref(receipt.service)}>{receipt.service}</a></Detail>
    <Detail label="API price"><span className="num">{receipt.apiPrice === null ? dash : usdOf(receipt.apiPrice)}</span></Detail>
    <Detail label="Buyer paid"><span className="num">{paidAmount(receipt)}</span></Detail>
    <Detail label="Our fee"><span className="num">{receipt.fee === null ? dash : usdOf(receipt.fee)}</span></Detail>
    <Detail label="API time"><span className="num">{receipt.ms.api === null ? dash : ms(receipt.ms.api)}</span></Detail>
    <Detail label="End to end"><span className="num">{receipt.ms.total === null ? dash : seconds(receipt.ms.total)}</span></Detail>
    <Detail label="Receipt id"><div className="mono small break">{receipt.id}</div></Detail>
  </div>
);

const Steps = ({ receipt }: { readonly receipt: Receipt }) => (
  <div className="steps">
    {receipt.steps.map(({ step, at }) => {
      const words = stepWords(step, receipt);

      return (
        <div className="tl" key={`${step}-${at}`}>
          <span className="time">{stepTime(at)}</span>
          <span className={step === 'released' ? 'step' : 'step done'}><span className="n"><Icon name={step === 'released' ? 'info' : 'check'} /></span></span>
          <div className="tl-body">
            <div className="t">{words.title}</div>
            {words.note === undefined ? null : <p className="small muted">{words.note}</p>}
          </div>
        </div>
      );
    })}
  </div>
);

/** The receipt of one call: the head, the Overview with its three boxes, details and steps, and the JSON as the API answered. */
export const ReceiptView = ({ receipt, siteUrl }: { readonly receipt: Receipt; readonly siteUrl: string }) => {
  const paid = receipt.status === 'paid';
  const text = jsonText(receipt);
  const link = `${siteUrl}/calls/${encodeURIComponent(receipt.id)}`;

  return (
    <div className="receipt">
      <nav className="row small muted" aria-label="Breadcrumb">
        <a className="link" href="/calls">Calls</a><span>/</span><span className="mono break">{receipt.id}</span>
      </nav>

      <div className="receipt-head mt-16">
        <div className="stack receipt-title">
          <span className="eyebrow">{receiptEyebrow}</span>
          <h1 className="balance">{paidAmount(receipt)}</h1>
          <div className="row">
            <Badge tone={paid ? 'success' : 'danger'} icon={paid ? 'check' : 'info'}>{statusWords(receipt)}</Badge>
            <span className="small muted">{utcMoment(receipt.at)}{receipt.ms.total === null ? '' : ` · ${seconds(receipt.ms.total)} end to end`}</span>
          </div>
        </div>
        <div className="row">
          <CopyButton text={link} label="Copy link" size="md" />
          <Button variant="secondary" href={serviceHref(receipt.service)}>Service</Button>
        </div>
      </div>

      <div className="receipt-tabs mt-32">
        <Tabs
          label="Receipt"
          items={[
            {
              id: 'overview',
              label: 'Overview',
              content: (
                <div className="stack-xl">
                  <div className="route-map">
                    <BuyerBox receipt={receipt} />
                    <div className="link-line" />
                    <RouteBox receipt={receipt} />
                    <div className="link-line" />
                    <ApiBox receipt={receipt} />
                  </div>
                  <div className="card pad-lg stack-lg">
                    <h2 className="card-title">Details</h2>
                    <Details receipt={receipt} />
                    {receipt.steps.length === 0 ? null : (
                      <>
                        <div className="divider-line" />
                        <h2 className="card-title">Steps</h2>
                        <Steps receipt={receipt} />
                      </>
                    )}
                  </div>
                </div>
              ),
            },
            { id: 'json', label: 'JSON', content: <CodeBlock code={text} tall>{highlightJson(text)}</CodeBlock> },
          ]}
        />
      </div>
    </div>
  );
};
