import { CodeBlock } from '../components/CodeBlock';
import type { Hosts } from '../agents/examples';
import { consoleLead, consolePlans, consoleTitle, todayCards, todayHeading, todayLead, todayLinks } from './content';

/**
 * The Console page: what the console will do, and the same things by request, with a command to copy for each. It
 * has no form and no key field, and it takes no key. `amount` is a top-up link's amount, already a number.
 */
export const ConsoleView = ({ hosts, amount }: { readonly hosts: Hosts; readonly amount?: number | undefined }) => (
  <section className="band">
    <div className="container ruled section console">
      <div className="console-column stack-lg">
        <div className="stack">
          <h1 className="console-title">{consoleTitle}</h1>
          <p className="lead">{consoleLead}</p>
          <ul className="console-plans">
            {consolePlans.map(line => <li key={line}>{line}</li>)}
          </ul>
        </div>
        <div className="stack">
          <h2 className="console-heading">{todayHeading}</h2>
          <p className="small muted">{todayLead}</p>
        </div>
        {todayCards(hosts, amount).map(card => (
          <div key={card.id} className="card raised pad-lg stack">
            <h3 className="card-title">{card.title}</h3>
            <p className="small muted">{card.note}</p>
            <CodeBlock code={card.command} wrap />
          </div>
        ))}
        <p className="small muted">
          More in{' '}
          {todayLinks(hosts).map((link, index) => (
            <span key={link.href}>{index > 0 ? ' and ' : ''}<a className="link" href={link.href}>{link.label}</a></span>
          ))}
          .
        </p>
      </div>
    </div>
  </section>
);
