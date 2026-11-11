import Link from 'next/link';

import type { ApiResult } from '../api/reader';
import type { ServicesPage } from '../api/types';
import { Button, buttonClass } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { LinkPending } from '../check/LinkPending';
import { MethodSelect } from '../check/MethodSelect';
import { agentPrompt, agentsText, hero, nearIntentsUrl, questions, topText, tryHref, tryLinks, ways } from '../content/home';
import { count, usdOf } from '../format';
import { servicePath } from '../services/content';

/** The hero: the line, the link field, and the console. The field is a plain GET form, so it works without scripts. */
export const Hero = ({ consoleUrl }: { readonly consoleUrl: string }) => (
  <section className="band">
    <div className="container ruled hero">
      <div className="stack-lg">
        <span className="eyebrow">{hero.eyebrow}</span>
        <h1 className="display">{hero.line}</h1>
        <p className="lead">{hero.lead}</p>
        <form className="hero-check stack" action="/check" method="get">
          <div className="check-row">
            <div className="check-box">
              <span className="lead-icon"><Icon name="link" /></span>
              <MethodSelect value="GET" />
              <input name="url" autoComplete="off" spellCheck={false} placeholder={hero.placeholder} aria-label="A paid API link" />
              <Button size="xl" type="submit">Check link</Button>
            </div>
            <Button variant="outline" size="xl" className="console-btn" href={consoleUrl}>Open the console</Button>
          </div>
          <div className="under-row">
            <div className="row small muted">
              <span>Try:</span>
              {tryLinks.map(link => (
                <Link key={link.url} className="chip" href={tryHref(link)}>{link.label} <span className="muted">{link.note}</span><LinkPending /></Link>
              ))}
            </div>
            <span className="small muted">{hero.freeCredits}</span>
          </div>
        </form>
      </div>
    </div>
  </section>
);

// What the Copy buttons of the two samples copy: the commands, without the prompt and the answers
const walletCopy = (pay: string): string => `curl ${pay}/<api host>/<path>\nx402 pay --network near:mainnet …`;
const keyCopy = (pay: string, api: string): string => [
  `curl ${api}/v1/topups -d '{"network":"<network>","token":"<token>","amount":"<amount>"}'`,
  `curl ${api}/v1/keys -d '{"dailyBudget":"<USD per day>","maxPrice":"<USD per call>"}'`,
  `curl ${pay}/<api host>/<path> -H "Authorization: Bearer af_live_…"`,
].join('\n');

// A host without its scheme, such as pay.example.com
const hostOf = (url: string): string => new URL(url).host;

/** The two ways to pay. The samples hold placeholders in angle brackets where a value would be, and the hosts of this deployment. */
export const TwoWays = ({ payUrl, apiUrl, consoleUrl }: { readonly payUrl: string; readonly apiUrl: string; readonly consoleUrl: string }) => {
  const pay = hostOf(payUrl);
  const api = hostOf(apiUrl);

  return (
    <section className="band">
      <div className="container ruled section">
        <div className="section-head">
          <h2 className="h2">{ways.heading}</h2>
          <p className="lead">{ways.lead} <a className="link intents-link" href={nearIntentsUrl}>NEAR Intents</a> moves our money between the two.</p>
        </div>
        <div className="grid g2">
          <div className="card pad-lg way-card">
            <div className="row way-head"><span className="tile brand"><Icon name="wallet" /></span><div><h3 className="h4">{ways.wallet.title}</h3><p className="small muted">{ways.wallet.text}</p></div></div>
            <CodeBlock code={walletCopy(pay)} copyName="Copy the commands of this sample">
              <span className="p">$</span> curl {pay}/<b>&lt;api host&gt;</b>/&lt;path&gt;{'\n'}
              <span className="warn">402 Payment Required</span>{'\n'}
              {'  '}accepts: <span className="s">NEAR</span> · Base · Solana · Tempo · key{'\n'}
              {'  '}price:   <span className="n">&lt;price&gt;</span> USD, the same on every chain{'\n\n'}
              <span className="p">$</span> x402 pay --network near:mainnet …{'\n'}
              <span className="ok">200 OK</span>  Anyfare-Receipt: id=&quot;pay_…&quot;
            </CodeBlock>
            <ul className="small muted stack way-notes">
              <li>Your payment settles only after the API answers <code>2xx</code>.</li>
              <li>{ways.wallet.notes[1]}</li>
            </ul>
          </div>
          <div className="card pad-lg way-card">
            <div className="row way-head"><span className="tile brand"><Icon name="key" /></span><div><h3 className="h4">{ways.key.title}</h3><p className="small muted">{ways.key.text}</p></div></div>
            <CodeBlock code={keyCopy(pay, api)} copyName="Copy the commands of this sample">
              <span className="p">$</span> curl {api}/v1/topups -d &apos;{'{'}&quot;network&quot;:&quot;&lt;network&gt;&quot;,&quot;token&quot;:&quot;&lt;token&gt;&quot;,&quot;amount&quot;:&quot;&lt;amount&gt;&quot;{'}'}&apos;{'\n'}
              {'  '}send at least &lt;amount&gt; to <span className="s">&lt;deposit address&gt;</span>, by &lt;time&gt;{'\n\n'}
              <span className="p">$</span> curl {api}/v1/keys -d &apos;{'{'}&quot;dailyBudget&quot;:&quot;&lt;USD per day&gt;&quot;,&quot;maxPrice&quot;:&quot;&lt;USD per call&gt;&quot;{'}'}&apos;{'\n'}
              {'  '}key: <span className="s">af_live_…</span>   shown once{'\n\n'}
              <span className="p">$</span> curl {pay}/&lt;api host&gt;/&lt;path&gt; -H &quot;Authorization: Bearer af_live_…&quot;{'\n'}
              <span className="ok">200 OK</span>  no transaction per call
            </CodeBlock>
            <div className="row"><Button href={`${consoleUrl}/topup`}>Top up</Button><Button variant="secondary" href={`${consoleUrl}/keys`}>Make a key</Button></div>
          </div>
        </div>
      </div>
    </section>
  );
};

/** The 5 services agents paid most: a service that was only checked is never here. A failed read shows its error, and no paid service shows the empty state. */
export const TopServices = ({ services }: { readonly services: ApiResult<ServicesPage> }) => (
  <section className="band">
    <div className="container ruled section">
      <div className="section-head row-head">
        <div className="stack top-intro"><h2 className="h2">{topText.heading}</h2><p className="lead">{topText.lead}</p></div>
        <Button variant="outline" size="lg" href="/services">All services</Button>
      </div>
      {!services.ok ? (
        <ErrorState title="The services didn't load">The Platform API didn&apos;t answer. Reload the page in a moment.</ErrorState>
      ) : services.value.services.length === 0 ? (
        <div className="card flush"><EmptyState icon="list" title="No paid services yet">Services appear here once agents have paid them through Anyfare.</EmptyState></div>
      ) : (
        <DataTable label="Top 5 services">
          <thead><tr><th>Service</th><th className="r">Paid endpoints</th><th className="r">Price from</th><th className="r">Calls through Anyfare</th><th className="r">Buyers</th><th className="r">Volume</th><th><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {services.value.services.map(service => (
              <tr key={service.host} className="click">
                <td><Link className="row-link row-title cut top-host" href={servicePath(service.host)} title={service.host}>{service.host}</Link></td>
                <td className="r">{count(service.paidEndpoints)}</td>
                <td className="r">{usdOf(service.priceFrom)}</td>
                <td className="r semi">{count(service.calls)}</td>
                <td className="r">{count(service.buyers)}</td>
                <td className="r">{usdOf(service.volume)}</td>
                <td className="r"><Icon name="chev" className="chev" /></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  </section>
);

/** The prompt to give an agent, with a Copy button. `siteUrl` is this website's own address. */
export const ForAgents = ({ siteUrl }: { readonly siteUrl: string }) => (
  <section className="band">
    <div className="container ruled section">
      <div className="split even agents-split">
        <div className="stack-lg">
          <span className="eyebrow">{agentsText.eyebrow}</span>
          <h2 className="h2">{agentsText.heading}</h2>
          <p className="lead">It reads one file, signs up with your permission, and calls with a key that has the limits you set. Every page here has a Markdown twin and a JSON API. Try <b>Agent</b> in the header.</p>
          <div className="row"><Button size="lg" href="/agents">For agents</Button><a className={buttonClass({ variant: 'secondary', size: 'lg' })} href="/llms.txt">Read llms.txt</a></div>
        </div>
        <CodeBlock code={agentPrompt(siteUrl)} wrap />
      </div>
    </div>
  </section>
);

/** The questions, as details; the first is open. */
export const Questions = () => (
  <section className="band">
    <div className="container ruled section">
      <div className="stack-xl">
        <div className="stack-lg"><h2 className="h2">Questions</h2><p className="lead">How to use Anyfare with an agent, and what it saves you.</p></div>
        <div>
          {questions.map(({ q, a }, index) => (
            <details key={q} className="faq" {...index === 0 ? { open: true } : {}}><summary>{q}</summary><p>{a}</p></details>
          ))}
        </div>
      </div>
    </div>
  </section>
);
