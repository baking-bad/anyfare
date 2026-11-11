'use client';

import { useRef, useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { Icon } from '../../components/Icon';
import { RailIcon } from '../../components/Rail';
import { Skeleton } from '../../components/Skeleton';
import { usd, usdOf } from '../../format';
import type { NewTopup, Topup, TopupOptions } from '../api';
import { problemText, type Read } from '../context';
import { amountAfterPick, checkAmount, linkAmountText, linkFill, underMinimum } from './amounts';
import { defaultChoice, isDollarToken, tokenChoices, tokenParam, tokensMissing, type TokenChoice } from './options';
import { networkName, topupBadge } from './status';
import { TokenDialog } from './TokenDialog';

/** The amount a top-up link brought: none, a number from $1 to $1,000, or one that was not used. */
export type FormLink = { readonly kind: 'none' } | { readonly kind: 'used'; readonly amount: number } | { readonly kind: 'unused' };

/** What the form says about a request that made no address: the page's own heading and the API's message. */
export interface Refusal {
  readonly code: string;
  readonly title: string;
  readonly text: string;
}

const HowItWorks = () => (
  <div className="stack-lg">
    <section className="card stack" aria-labelledby="topup-how">
      <h2 id="topup-how" className="card-title">How it works</h2>
      <ol className="steps topup-steps">
        <li className="step"><span className="n" aria-hidden="true">1</span><div><div className="t">We ask NEAR Intents for an address</div><p className="small muted">For this top-up only. It tells us whose money arrived.</p></div></li>
        <li className="step"><span className="n" aria-hidden="true">2</span><div><div className="t">You send from any wallet or exchange</div><p className="small muted">Send at least the amount shown. An exchange may take its fee out.</p></div></li>
        <li className="step"><span className="n" aria-hidden="true">3</span><div><div className="t">It becomes USDC on NEAR</div><p className="small muted">We add 1 Credit for each USDC that arrives.</p></div></li>
      </ol>
    </section>
    <div className="alert warning">
      <Icon name="alert" />
      <div className="stack tight"><span className="t">One way</span><span>Credits can&apos;t be taken out again. Top up what your agents will spend.</span></div>
    </div>
  </div>
);

/**
 * The form: the amount and the token (from the "Pick a token" dialog), the least for its network, our fee, and "Get a
 * deposit address". The amount is checked before it is sent. The page sends the request (`onSend`) and holds it, one
 * at a time: while it runs, this form, and one shown again after another view, has its button disabled and says an
 * address is being made. A link's amount fills a dollar token's field.
 */
export const TopupForm = ({ options, optionsAgain, link, inProgress, sending, refusal, onOpen, onSend, onChange }: {
  readonly options: Read<TopupOptions>;
  readonly optionsAgain: () => void;
  readonly link: FormLink;
  // The newest top-up, still open, when a link's amount opened the form instead of it
  readonly inProgress: Topup | undefined;
  // A request for an address runs
  readonly sending: boolean;
  // What came of the last request, when it made no address
  readonly refusal: Refusal | undefined;
  readonly onOpen: (topup: Topup) => void;
  // Asks for an address: the body, the token's symbol and the network's name as the page says it
  readonly onSend: (body: NewTopup, symbol: string, network: string) => void;
  // The person changed the amount or the token: the last refusal no longer applies
  readonly onChange: () => void;
}) => {
  const field = useRef<HTMLInputElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const [pickedKey, setPickedKey] = useState<string | undefined>(undefined);
  // What the person typed; undefined until they type or pick, so the link's amount shows first
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [tried, setTried] = useState(false);
  const linkAmount = link.kind === 'used' ? link.amount : undefined;

  const choices = options.state === 'ok' ? tokenChoices(options.value) : [];
  const chosen: TokenChoice | undefined = choices.find(choice => choice.key === pickedKey) ?? defaultChoice(choices);
  const fill = chosen === undefined || linkAmount === undefined ? undefined : linkFill(linkAmount, chosen.symbol);
  const value = typed ?? (fill?.kind === 'fill' ? fill.value : '');
  const check = chosen === undefined ? undefined : checkAmount(value, chosen);
  const under = chosen !== undefined && check?.ok === true ? underMinimum(check.amount, chosen) === true : false;
  const fromLink = linkAmount !== undefined && chosen !== undefined && isDollarToken(chosen.symbol) && value.trim() === linkAmountText(linkAmount);
  const showProblem = check !== undefined && !check.ok && (tried || value.trim() !== '');
  const network = chosen === undefined ? '' : networkName(chosen.network);

  const pick = (next: TokenChoice): void => {
    if (next.key !== chosen?.key)
      setTyped(amountAfterPick(value, chosen, next, linkAmount));
    setPickedKey(next.key);
    setPicking(false);
    setTried(false);
    onChange();
  };

  const send = (): void => {
    // The button is disabled while a request runs; the page's sender also refuses a second click that comes before it is
    if (sending || chosen === undefined || check === undefined)
      return;
    if (!check.ok) {
      setTried(true);
      field.current?.focus();

      return;
    }
    if (under)
      return;
    onSend({ network: chosen.network, token: tokenParam(chosen), amount: check.amount }, chosen.symbol, network);
  };

  const missing = options.state === 'ok' && (tokensMissing(options.value) || choices.length === 0);

  return (
    <div className="split topup-split">
      <section className="card pad-lg stack-lg topup-card" aria-label="New top-up">
        {link.kind === 'used' ? (
          <div className="alert info">
            <Icon name="link" />
            <div className="stack tight">
              <span className="t">{usd(link.amount)} from the link</span>
              <span>The link you opened asked for this amount. Only the amount came from it. Check it, pick a token, then get the address. You can change it.</span>
            </div>
          </div>
        ) : link.kind === 'unused' ? (
          <div className="alert warning">
            <Icon name="alert" />
            <div className="stack tight">
              <span className="t">The amount in the link was not used</span>
              <span>It wasn&apos;t a number from $1 to $1,000. Enter the amount yourself.</span>
            </div>
          </div>
        ) : null}
        {inProgress === undefined ? null : (
          <div className="topup-progress">
            <Icon name="clock" />
            <span className="small grow">
              <b>You have a top-up in progress</b>: {inProgress.amount} {inProgress.token} on {networkName(inProgress.network)}, {topupBadge(inProgress.status).label.toLowerCase()}.
            </span>
            <Button variant="secondary" size="sm" onClick={() => onOpen(inProgress)}>Open it</Button>
          </div>
        )}
        {options.state === 'failed' ? (
          <ErrorState title="The networks didn't load" action={<Button variant="secondary" size="sm" onClick={optionsAgain}>Try again</Button>}>{problemText(options.error)}</ErrorState>
        ) : (
          <>
            <div className="amount-box">
              <div className="amount-head small muted">
                <span className="row amount-label">
                  <label htmlFor="topup-amount">You send</label>
                  {fromLink ? <Badge>From the link</Badge> : null}
                </span>
                {chosen === undefined ? null : <span>At least {usdOf(chosen.minimum)}</span>}
              </div>
              <div className="amount-row">
                <input
                  ref={field}
                  id="topup-amount"
                  className="amount-input"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0"
                  maxLength={64}
                  value={value}
                  disabled={options.state === 'loading' || chosen === undefined}
                  aria-invalid={showProblem || under ? true : undefined}
                  aria-describedby={showProblem ? 'topup-amount-problem' : undefined}
                  onChange={event => {
                    setTyped(event.target.value);
                    onChange();
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                {options.state === 'loading' ? <span className="token-pill pending" role="status" aria-label="Reading the tokens"><Skeleton width="sm" /></span> : (
                  <button
                    ref={pill}
                    type="button"
                    className="token-pill"
                    aria-haspopup="dialog"
                    aria-label={chosen === undefined ? 'Pick a token' : `Token: ${chosen.symbol} on ${network}. Pick another`}
                    onClick={() => setPicking(true)}
                  >
                    {chosen === undefined ? <span className="pill-pick">Pick a token</span> : <><RailIcon rail={chosen.network} token={chosen.symbol} size={32} />{chosen.symbol} · {network}</>}
                    <Icon name="down" />
                  </button>
                )}
              </div>
            </div>
            {showProblem && check !== undefined && !check.ok ? <p id="topup-amount-problem" className="small field-error" role="alert">{check.problem}</p> : null}
            {fill?.kind === 'ask' ? <p className="small">{fill.line}</p> : null}
            <dl className="kv topup-terms">
              <dt>Our fee</dt><dd>$0.00</dd>
              <dt>You get</dt><dd>1 Credit for each USDC that arrives</dd>
            </dl>
            {under && chosen !== undefined ? (
              <div className="alert warning" role="alert">
                <Icon name="alert" />
                <div className="stack tight"><span className="t">Under the least for {network}</span><span>A top-up on {network} must be worth at least {usdOf(chosen.minimum)}. Raise the amount or pick another network.</span></div>
              </div>
            ) : null}
            {refusal === undefined ? null : (
              <div className={refusal.code === 'unknown' ? 'alert danger' : 'alert warning'} role="alert">
                <Icon name="alert" />
                <div className="stack tight"><span className="t">{refusal.title}</span><span>{refusal.text}</span></div>
              </div>
            )}
            <Button size="xl" className="topup-go" loading={sending} disabled={chosen === undefined || under} onClick={send}>Get a deposit address</Button>
            {sending ? <p className="small muted topup-sending" role="status">A deposit address is being made: NEAR Intents can take up to a minute. It opens here when it is ready.</p> : null}
            <p className="xs muted">The estimate comes with the address. We credit what arrives, not what was quoted.</p>
          </>
        )}
      </section>
      <HowItWorks />
      {picking && options.state !== 'failed' ? (
        <TokenDialog
          networks={options.state === 'ok' ? options.value.networks : []}
          choices={choices}
          chosen={chosen?.key}
          missing={missing}
          retrying={options.state === 'loading'}
          onRetry={optionsAgain}
          onPick={pick}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
};
