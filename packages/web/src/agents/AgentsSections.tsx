import { Badge } from '../components/Badge';
import { Button, buttonClass } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { Icon } from '../components/Icon';
import { agentPrompt } from '../content/home';
import { apiText, endpointGroups, fileCards, hero, llmsText, startSteps, startText } from './content';
import type { Endpoint } from './endpoints';
import { curlById, type Hosts } from './examples';
import { agentLinks, llmsFullPath, skillPath } from './links';

// The sections of the For agents page. Each takes the settings it needs, so every host and link comes from them.

const methodClass = (method: string): string => ({ GET: 'get', POST: 'post', SSE: 'sse', DELETE: 'del' } as Record<string, string>)[method] ?? '';

/** The hero: the line, the prompt with its Copy button, and the line under it. */
export const AgentsHero = ({ siteUrl }: { readonly siteUrl: string }) => (
  <section className="band">
    <div className="container ruled section agents-hero">
      <div className="split even agents-split">
        <div className="stack-lg">
          <span className="eyebrow">{hero.eyebrow}</span>
          <h1 className="display agents-title">{hero.line}</h1>
          <p className="lead">{hero.lead}</p>
          <div className="row">
            <Button size="lg" href="/llms.txt">Read llms.txt</Button>
            <a className={buttonClass({ variant: 'secondary', size: 'lg' })} href="#api">The API</a>
          </div>
        </div>
        <div className="stack">
          <span className="label">{hero.promptLabel}</span>
          <CodeBlock code={agentPrompt(siteUrl)} wrap />
          <p className="small muted">{hero.wallet}</p>
        </div>
      </div>
    </div>
  </section>
);

/** The four cards: the files an agent reads. Each is a real link. */
export const FileCards = ({ hosts }: { readonly hosts: Hosts }) => {
  const cards = fileCards(hosts);

  return (
    <section className="band">
      <div className="container ruled section tight">
        <div className="grid g4">
          <a className="card clickable stack agent-card" href={cards.llms.href}><span className="tile"><Icon name="file" /></span><span className="card-title">{cards.llms.title}</span><span className="small muted">{cards.llms.text}</span></a>
          <a className="card clickable stack agent-card" href={cards.skill.href}><span className="tile"><Icon name="book" /></span><span className="card-title">{cards.skill.title}</span><span className="small muted">{cards.skill.text}</span></a>
          <div className="card stack">
            <span className="tile"><Icon name="terminal" /></span>
            <span className="card-title">{cards.openapi.title}</span>
            <span className="small muted">{cards.openapi.text}</span>
            <span className="row small"><a className="link mono" href={cards.openapi.api}>API host</a><a className="link mono" href={cards.openapi.pay}>Pay host</a></span>
          </div>
          <a className="card clickable stack agent-card" href={cards.twin.href}><span className="tile"><Icon name="bot" /></span><span className="card-title">{cards.twin.title}</span><span className="small muted">{cards.twin.text}</span></a>
        </div>
      </div>
    </section>
  );
};

// `200 OK` and the receipt: the status in color, the rest as it is
const AnswerLine = ({ answer }: { readonly answer: string }) => answer.startsWith('200 OK')
  ? <><span className="ok">200 OK</span>{answer.slice('200 OK'.length)}</>
  : <span className="c">→ {answer}</span>;

/** "Start in four requests": the four cards, each with its command and the shape of its answer. */
export const StartSteps = ({ hosts }: { readonly hosts: Hosts }) => (
  <section className="band" id="start">
    <div className="container ruled section">
      <div className="section-head"><h2 className="h2">{startText.heading}</h2><p className="lead">{startText.lead}</p></div>
      <div className="grid g2 start-grid">
        {startSteps(hosts).map(step => (
          <div key={step.number} className="card stack">
            <div className="row"><span className="badge">{step.number}</span><span className="card-title">{step.title}</span>{step.optional === true ? <span className="badge">Optional</span> : null}</div>
            <pre className="code wrap" tabIndex={0}>{curlById(hosts, step.example)}{'\n'}<AnswerLine answer={step.answer} /></pre>
            <p className="small muted">{step.note}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

const EndpointRow = ({ endpoint, hosts }: { readonly endpoint: Endpoint; readonly hosts: Pick<Hosts, 'apiUrl' | 'payUrl'> }) => {
  const origin = new URL(endpoint.host === 'pay' ? hosts.payUrl : hosts.apiUrl).host;

  return (
    <div className="ep-row">
      <span><span className={`method ${methodClass(endpoint.method)}`.trim()}>{endpoint.method}</span></span>
      <span className="ep-path"><code><span className="muted">{origin}</span>{endpoint.path}</code></span>
      <span className="muted">{endpoint.summary}</span>
      <span className="small">{endpoint.who}</span>
      <span className="ep-state"><Badge tone="success">Built</Badge></span>
    </div>
  );
};

/** "The API": every endpoint of the shared list, grouped, with who may call it. */
export const ApiTable = ({ hosts }: { readonly hosts: Hosts }) => (
  <section className="band" id="api">
    <div className="container ruled section">
      <div className="section-head row-head">
        <div className="stack api-intro"><h2 className="h2">{apiText.heading}</h2><p className="lead">{apiText.lead}</p></div>
        <div className="legend"><span><Badge tone="success">Built</Badge></span><a className="link small" href={llmsFullPath}>Every request and answer</a></div>
      </div>
      <div className="t-wrap">
        <div className="inner rows">
          {endpointGroups().map(({ group, title, endpoints }) => (
            <div key={group} className="ep-group" role="group" aria-label={title}>
              <div className="ep-group-title">{title}</div>
              {endpoints.map(endpoint => <EndpointRow key={`${endpoint.method} ${endpoint.path}`} endpoint={endpoint} hosts={hosts} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

/** "llms.txt": the real file's text, with Copy, and the links to the other files and the twins. */
export const LlmsSection = ({ hosts, guide }: { readonly hosts: Hosts; readonly guide: string }) => {
  const links = agentLinks(hosts);

  return (
    <section className="band" id="llms">
      <div className="container ruled section">
        <div className="split agents-split">
          <div className="stack-lg">
            <h2 className="h2">{llmsText.heading}</h2>
            <p className="lead">{llmsText.lead}</p>
            <div id="skill" className="stack">
              <span className="label">Also</span>
              <a className="link small mono" href={llmsFullPath}>{llmsFullPath}</a>
              <a className="link small mono" href={skillPath}>{skillPath}</a>
              <span id="md" className="stack">
                <a className="link small mono" href={links.twin}>/agents.md</a>
                <a className="link small mono" href="/services.md">/services.md</a>
                <a className="link small mono" href="/calls.md">/calls.md</a>
                <span className="small muted mono">/services/&lt;host&gt;.md</span>
              </span>
            </div>
          </div>
          <CodeBlock code={guide} wrap tall />
        </div>
      </div>
    </section>
  );
};
