import Link from 'next/link';
import type { ReactNode } from 'react';

import type { ApiResult } from '../api/reader';
import type { CallsPage, EndpointStats } from '../api/types';
import { Badge } from '../components/Badge';
import { Button, buttonClass } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { CopyButton } from '../components/CopyButton';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { highlightJson, jsonText } from '../components/Json';
import { Rail } from '../components/Rail';
import { Tabs } from '../components/Tabs';
import { tryHref, tryLinks } from '../content/home';
import { ago, ms, usdOf } from '../format';
import { fromCheck, isHost, servicePath } from '../services/content';
import type { PayableCheck, Refusal } from './answer';
import { CheckCalls } from './CheckCalls';
import { CheckStats } from './CheckStats';
import {
  askRows, asksSentence, bodyFlags, knownMethod, byHandNote, checkAddress, checkTabs, codeSamples, cut, defaultMethod, describedAs, emptyLine, linkParts, methodFlag, offersPost, refusalWords, shellWord,
  pathLines, tryPostLabel, tryPostLine, ownPayButton, ownPayLine, ownPayTitle, unlistedLine, wayWords,
  type CheckMethod, type CheckParams, type CheckTab, type HttpMethod,
} from './content';
import { LinkPending } from './LinkPending';
import { LinkTabs } from './LinkTabs';

// The pieces of the Check page. Every value that comes from the pay host's answer is rendered as text.

const methodTone = (method: HttpMethod): string => ({ GET: 'get', POST: 'post', PUT: 'post', PATCH: 'sse', DELETE: 'del' } as Record<HttpMethod, string>)[method];

/**
 * The host and the path of a link, in the mono font: the host in full color, the path a little lighter. A
 * method that is not GET shows as a chip before the link.
 */
const LinkTitle = ({ host, path, method }: { readonly host: string; readonly path: string; readonly method?: HttpMethod }) => (
  <div className="url-title">
    {method === undefined || method === 'GET' ? null : <span className={['method', methodTone(method), 'url-method'].filter(Boolean).join(' ')}>{method}</span>}
    <span className="host">{host}</span><span className="path">{path}</span>
  </div>
);

/** No link yet: one line, and the two example links of the home page. */
export const CheckEmpty = () => (
  <div className="stack check-empty">
    <p className="lead">{emptyLine}</p>
    <div className="row small muted">
      <span>Try:</span>
      {tryLinks.map(link => (
        <Link key={link.url} className="chip" href={tryHref(link)}>{link.label} <span className="muted">{link.note}</span><LinkPending /></Link>
      ))}
    </div>
  </div>
);

/** The pay host didn't answer, or answered with something unreadable: the shared error state, with the field still usable above. */
export const CheckUnavailable = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div className="check-card-wrap"><ErrorState title={title}>{children}</ErrorState></div>
);

/** The card for a link that can't be paid, worded by the refusal's reason. */
export const CheckRefused = ({ refusal, url, method }: { readonly refusal: Refusal; readonly url: string; readonly method: CheckMethod }) => {
  const { title, text } = refusalWords(refusal, method);
  const post = offersPost(refusal, method);
  const { host, path } = linkParts(url);
  const lines = pathLines(refusal, true);
  const shown = host !== '' && url.length <= 600 ? <LinkTitle host={host} path={path} method={refusal.method ?? knownMethod(method)} /> : url === '' ? null : <div className="url-title"><span className="host">{cut(url, 120)}</span></div>;

  return (
    <div className="card pad-lg check-refused">
      <div className="stack check-refused-inner">
        <span className="icon-circle"><Icon name="link" /></span>
        <h1 className="h3">{title}</h1>
        {shown}
        <p className="muted check-refused-text">{text}</p>
        {lines.length === 0 ? null : <p className="xs muted check-refused-text">{lines.join(' ')}</p>}
        {post ? <p className="small muted check-refused-text">{tryPostLine}</p> : null}
        <div className="row check-refused-actions">
          {post ? <Button href={checkAddress({ url, method: 'POST', tab: 'overview', period: '30d', page: 1 })}>{tryPostLabel}</Button> : null}
          <Button variant={post ? 'secondary' : 'primary'} href="/services">Browse services</Button>
          <Button variant={post ? 'outline' : 'secondary'} href="/">Check another link</Button>
        </div>
      </div>
    </div>
  );
};

/** A link to the pay host itself: it says so, and offers the check of the link inside it. Nothing was asked of the pay host. */
export const CheckOwnLink = ({ inner, method, payHost }: { readonly inner: string; readonly method: CheckMethod; readonly payHost: string }) => (
  <div className="card pad-lg check-refused">
    <div className="stack check-refused-inner">
      <span className="icon-circle"><Icon name="link" /></span>
      <h1 className="h3">{ownPayTitle}</h1>
      <p className="muted check-refused-text">{ownPayLine(payHost)}</p>
      <div className="row check-refused-actions">
        {inner === '' ? null : <Button href={checkAddress({ url: inner, method, tab: 'overview', period: '30d', page: 1 })}>{ownPayButton}</Button>}
        <Button variant={inner === '' ? 'primary' : 'secondary'} href="/services">Browse services</Button>
      </div>
    </div>
  </div>
);

// ---------- The head ----------

const checkedLine = (check: PayableCheck, now: number): string => {
  const time = check.checkedAt === undefined ? Number.NaN : Date.parse(check.checkedAt);
  const when = Number.isFinite(time) ? ago(time, now) : undefined;

  return ['Checked', when === undefined ? undefined : when === 'now' ? 'just now' : when, check.ms === undefined ? undefined : `· ${ms(check.ms)}`].filter(Boolean).join(' ');
};

const CheckHead = ({ check, now }: { readonly check: PayableCheck; readonly now: number }) => (
  <div className="row-between check-head">
    <div className="verdict">
      <span className="tile brand"><Icon name="zap" /></span>
      <div className="stack verdict-body">
        <LinkTitle host={check.host} path={check.path} method={check.method} />
        <div className="row">
          <Badge tone="success" icon="check">Payable through Anyfare</Badge>
          <span className="xs muted">{checkedLine(check, now)}</span>
        </div>
        {check.listed ? null : <p className="xs muted">{unlistedLine}</p>}
      </div>
    </div>
    <div className="row">
      <CopyButton text={check.link} label="Copy pay link" variant="primary" size="lg" withIcon />
      {check.listed && isHost(check.host) ? <Link prefetch={false} className={buttonClass({ variant: 'secondary', size: 'lg' })} href={`${servicePath(check.host)}?${fromCheck}`}>Service</Link> : null}
    </div>
  </div>
);

// ---------- Overview ----------

const Asks = ({ check }: { readonly check: PayableCheck }) => {
  const sentence = asksSentence(check);
  const rows = askRows(check);
  const description = describedAs(check.asks);
  const lines = pathLines(check);

  return (
    <div className="card pad-lg stack">
      <span className="eyebrow">What the API asks</span>
      <p className="sentence">
        {sentence.parts.map((part, index) => part.code
          ? <code key={index}>{part.text}</code>
          : part.strong ? <b key={index}>{part.text}</b> : part.text)}
      </p>
      {lines.length === 0 ? null : <div className="stack check-path">{lines.map(line => <p key={line} className="xs muted">{line}</p>)}</div>}
      {rows.length === 0 && description === undefined ? null : (
        <dl className="kv ask-kv mt-8">
          {rows.map(row => (
            <div key={row.label} className="kv-row">
              <dt>{row.label}</dt>
              <dd>{row.code ? <code title={row.value}>{row.value}</code> : row.value}</dd>
            </div>
          ))}
          {description === undefined ? null : (
            <div className="kv-row">
              <dt>Description</dt>
              <dd className="ask-description">{description}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
};

const PayWays = ({ check, payHost }: { readonly check: PayableCheck; readonly payHost: string }) => (
  <>
    <div className="t-wrap">
      <div className="well-title">
        <span>Pay it through Anyfare</span>
        {check.quote === undefined ? null : <Badge tone="success" icon="check">Fee {usdOf(check.quote.fee)}</Badge>}
      </div>
      <div className="inner rows">
        {check.payWith.length === 0 ? <p className="small muted pay-none">No way to pay is listed right now.</p> : check.payWith.map(way => {
          const words = wayWords(way);

          return (
            <div key={way.paidWith} className="pay-row">
              <div className="row pay-way">
                <Rail rail={way.paidWith} />
                <div className="ellipsis"><div className="small semi">{words.name}</div><div className="xs muted">{words.note}</div></div>
              </div>
              <span className="r semi">{usdOf(way.amount)}</span>
            </div>
          );
        })}
      </div>
    </div>
    <div className="stack mt-16">
      <span className="label">Your link through Anyfare</span>
      <div className="check-box link-box">
        <input readOnly value={check.link} aria-label="Pay link" />
        <CopyButton text={check.link} withIcon />
      </div>
      <p className="xs muted">Put <code>{payHost}/</code> in front of any paid link. The price that counts is the one the API asks at call time.</p>
    </div>
  </>
);

const FromYourAgent = ({ check, consoleUrl }: { readonly check: PayableCheck; readonly consoleUrl: string }) => {
  const { prompt } = codeSamples(check.link, check.method, check.exampleBody);

  return (
    <div className="card stack">
      <h2 className="card-title">Pay it from your agent</h2>
      <div className="steps mt-4">
        <div className="step"><span className="n">1</span><div><div className="t">Make a payment key</div><p className="small muted">In the <a className="link" href={`${consoleUrl}/keys`}>console</a>, with a budget per day and a highest price per call.</p></div></div>
        <div className="step"><span className="n">2</span><div><div className="t">Give your agent this</div><div className="mt-8 agent-prompt"><CodeBlock code={prompt} wrap /></div></div></div>
        <div className="step"><span className="n">3</span><div><div className="t">Watch the calls</div><p className="small muted">Each one shows under Last calls, and in your console&apos;s Payments.</p></div></div>
      </div>
      <p className="small muted">An agent with its own wallet needs no key. It calls the link, gets our 402, and pays in USDC on NEAR, Base or Solana, or over MPP on Tempo.</p>
    </div>
  );
};

const Overview = ({ check, stats, calls, params, now, payHost, consoleUrl }: {
  readonly check: PayableCheck;
  readonly stats: ApiResult<EndpointStats>;
  readonly calls: ApiResult<CallsPage>;
  readonly params: CheckParams;
  readonly now: number;
  readonly payHost: string;
  readonly consoleUrl: string;
}) => (
  <>
    <div className="split check-split">
      <div className="stack-lg">
        <Asks check={check} />
        <CheckStats host={check.host} path={check.path} params={params} stats={stats} period={params.period} fallback={check.stats} />
      </div>
      <div className="stack-lg side">
        <PayWays check={check} payHost={payHost} />
        <FromYourAgent check={check} consoleUrl={consoleUrl} />
      </div>
    </div>
    <div className="mt-32"><CheckCalls host={check.host} path={check.path} params={params} calls={calls} page={params.page} now={now} /></div>
  </>
);

// ---------- JSON, Headers, Code ----------

const JsonTab = ({ raw, payHost, method }: { readonly raw: unknown; readonly payHost: string; readonly method: CheckMethod }) => {
  const body = jsonText(raw);

  return (
    <div className="stack">
      <div className="row-between">
        <p className="small muted">The answer to <code>GET {payHost}/_/check?url=…{method === defaultMethod ? '' : `&method=${method}`}</code>, as it came.</p>
        <CopyButton text={body} label="Copy JSON" withIcon />
      </div>
      <pre className="code tall" tabIndex={0}>{highlightJson(body)}</pre>
    </div>
  );
};

const statusPhrases: Readonly<Record<number, string>> = { 200: 'OK', 402: 'Payment Required' };

const HeadersTab = ({ check }: { readonly check: PayableCheck }) => {
  const { upstream } = check;
  const request = `curl -i${methodFlag(check.method)} ${shellWord(check.target)}${bodyFlags(check.exampleBody)}`;
  const status = upstream.status === undefined ? undefined : `HTTP/1.1 ${upstream.status}${statusPhrases[upstream.status] === undefined ? '' : ` ${statusPhrases[upstream.status]}`}`;
  const plain = [`$ ${request}`, '', ...status === undefined ? [] : [status], ...upstream.headers.map(([name, value]) => `${name}: ${value}`)].join('\n');
  const decoded = upstream.decoded === undefined ? undefined : jsonText(upstream.decoded);

  return (
    <div>
      <CodeBlock code={plain} wrap>
        <span className="p">$</span> {request}{'\n\n'}
        {status === undefined ? null : <><span className="warn">{status}</span>{'\n'}</>}
        {upstream.headers.map(([name, value]) => <span key={name}><span className="k">{name}</span>{': '}{value}{'\n'}</span>)}
      </CodeBlock>
      {decoded === undefined ? null : (
        <>
          <p className="label mt-24">{upstream.decodedAs === 'mpp' ? <>The <code>www-authenticate</code> challenges, decoded</> : <>The <code>payment-required</code> header, decoded from base64</>}</p>
          <div className="mt-8"><CodeBlock code={decoded} tall>{highlightJson(decoded)}</CodeBlock></div>
        </>
      )}
    </div>
  );
};

const CodeTab = ({ check }: { readonly check: PayableCheck }) => {
  const samples = codeSamples(check.link, check.method, check.exampleBody);

  return (
    <Tabs
      label="How to call it"
      items={[
        { id: 'key', label: 'curl, with a key', content: <CodeBlock code={samples.key} wrap /> },
        {
          id: 'hand',
          label: 'curl, x402 by hand',
          content: (
            <>
              <CodeBlock code={samples.byHand} wrap />
              <p className="xs muted mt-8">{byHandNote}</p>
            </>
          ),
        },
        { id: 'prompt', label: 'Agent prompt', content: <CodeBlock code={samples.prompt} wrap /> },
      ]}
    />
  );
};

// ---------- A payable link ----------

const tabIcons: Readonly<Partial<Record<CheckTab, 'user' | 'bot'>>> = { overview: 'user', json: 'bot' };

/** The result for a payable link: the head, and the four tabs. The chosen tab comes from the URL. */
export const CheckPayable = ({ check, raw, stats, calls, params, now, payHost, consoleUrl }: {
  readonly check: PayableCheck;
  readonly raw: unknown;
  readonly stats: ApiResult<EndpointStats>;
  readonly calls: ApiResult<CallsPage>;
  readonly params: CheckParams;
  readonly now: number;
  readonly payHost: string;
  readonly consoleUrl: string;
}) => {
  const content: Readonly<Record<CheckTab, ReactNode>> = {
    overview: <Overview check={check} stats={stats} calls={calls} params={params} now={now} payHost={payHost} consoleUrl={consoleUrl} />,
    json: <JsonTab raw={raw} payHost={payHost} method={params.method} />,
    headers: <HeadersTab check={check} />,
    code: <CodeTab check={check} />,
  };

  return (
    <div className="check-result">
      <CheckHead check={check} now={now} />
      <div className="mt-32">
        <LinkTabs
          label="The check"
          selected={params.tab}
          items={checkTabs.map(tab => {
            const icon = tabIcons[tab.id];

            return {
              id: tab.id,
              label: <>{icon === undefined ? null : <Icon name={icon} />}{tab.label}</>,
              href: checkAddress({ ...params, tab: tab.id }),
              content: content[tab.id],
            };
          })}
        />
      </div>
    </div>
  );
};
