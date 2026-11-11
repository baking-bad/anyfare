'use client';

import { Fragment } from 'react';

import { CodeBlock } from '../components/CodeBlock';
import { CopyButton } from '../components/CopyButton';
import { Icon } from '../components/Icon';
import { useSettings } from '../components/Settings';
import { agentPageOf, consoleAgentNote, curlOfRequest } from './agentRequests';
import type { ConsolePageName } from './pages';

const methodClass = (method: string): string => ({ GET: 'get', POST: 'post', PATCH: 'post', DELETE: 'del' } as Record<string, string>)[method] ?? '';

/**
 * The console page as an agent does it: the requests behind it, each with its URL to copy, and the same requests as
 * `curl` commands. `amount` is a top-up link's amount, for Top up's sample body. The commands name the key as `$ANYFARE_MASTER_KEY`; no real key is ever in them.
 */
export const AgentPanel = ({ page, amount }: { readonly page: ConsolePageName; readonly amount?: number | undefined }) => {
  const { apiUrl } = useSettings();
  const agent = agentPageOf(page, amount);
  const commands = agent.requests.map(request => curlOfRequest(apiUrl, request));

  return (
    <div className="agent-view compact">
      <div className="stack-lg">
        <div className="stack">
          <span className="eyebrow row"><Icon name="bot" />This page, as an agent does it</span>
          <h1 className="page-title">{agent.title}</h1>
          {agent.lead === undefined ? null : <p className="muted agent-note">{agent.lead}</p>}
          <p className={agent.lead === undefined ? 'muted agent-note' : 'small muted agent-note'}>{consoleAgentNote}</p>
        </div>
        <div className="t-wrap">
          <div className="well-title">The requests behind this page</div>
          <div className="inner rows">
            {agent.requests.length === 0 ? <p className="ep-empty small muted">This page&apos;s requests are listed here when the page is built.</p> : agent.requests.map(request => (
              <div key={`${request.method} ${request.path}`} className="ep">
                <span><span className={`method ${methodClass(request.method)}`.trim()}>{request.method}</span></span>
                <span className="ep-url">
                  <code>{`${apiUrl}${request.path}`}</code>
                  <span className="muted xs ep-note">{request.keyed ? request.note : `${request.note}. No key`}</span>
                </span>
                <CopyButton text={`${apiUrl}${request.path}`} label={`Copy ${apiUrl}${request.path}`} variant="ghost" iconOnly />
              </div>
            ))}
          </div>
        </div>
        {commands.length === 0 ? null : (
          <CodeBlock code={commands.join('\n\n')} wrap>
            {commands.map((command, index) => <Fragment key={command}><span className="p">$</span> {command}{index < commands.length - 1 ? '\n\n' : ''}</Fragment>)}
          </CodeBlock>
        )}
        <p className="small muted">Switch back with <b>Human</b> at the top. The switch is kept in this browser.</p>
      </div>
    </div>
  );
};
