'use client';

import { Fragment, type ReactNode } from 'react';

import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import { highlightJson, jsonText } from './Json';
import { Tabs } from './Tabs';
import { useView } from './view';

/** One request behind a page. */
export interface AgentRequest {
  // GET, POST, SSE or DELETE
  readonly method: string;
  // The full URL
  readonly url: string;
  // What it answers, in a few words
  readonly note?: string;
}

/**
 * What an agent gets of a page. A page builds this and hands it to `PageView`.
 *
 * - `title`: the page's title.
 * - `markdown`: the page as Markdown.
 * - `json`: the page's data, any JSON value.
 * - `requests`: the requests behind the page. They are listed above the tabs, with a copy button each.
 * - `markdownUrl`: the full URL of the page's Markdown twin. It is listed first among the requests.
 */
export interface AgentViewProps {
  readonly title: string;
  readonly markdown: string;
  readonly json: unknown;
  readonly requests: readonly AgentRequest[];
  readonly markdownUrl: string;
}

const methodClass = (method: string): string => ({ GET: 'get', POST: 'post', SSE: 'sse', DELETE: 'del' } as Record<string, string>)[method] ?? '';

// The page's own address from its Markdown twin's: `/index.md` is `/`, `/services.md` is `/services`
const pageUrlOf = (markdownUrl: string): string => markdownUrl.endsWith('/index.md') ? markdownUrl.slice(0, -'index.md'.length) : markdownUrl.replace(/\.md$/, '');

// Read requests an agent can run as they are: the page by Accept, its twin, and the first request behind it
const curlLines = (markdownUrl: string, requests: readonly AgentRequest[]): readonly string[] => {
  const first = requests.find(request => request.method === 'GET');

  return [
    `curl -H "Accept: text/markdown" ${pageUrlOf(markdownUrl)}`,
    `curl ${markdownUrl}`,
    ...first === undefined ? [] : [`curl ${first.url}`],
  ];
};

/** The page the way an agent reads it: the requests behind it, then its Markdown, JSON and curl, each with a copy button. */
export const AgentView = ({ title, markdown, json, requests, markdownUrl }: AgentViewProps) => {
  const text = jsonText(json);
  const all: readonly AgentRequest[] = [{ method: 'GET', url: markdownUrl, note: 'This page as Markdown' }, ...requests];
  const curl = curlLines(markdownUrl, requests);

  return (
    <div className="band">
      <div className="container ruled agent-view">
        <div className="stack-lg">
          <div className="stack">
            <span className="eyebrow row"><Icon name="bot" />This page, as an agent reads it</span>
            <h1 className="page-title">{title}</h1>
            <p className="muted agent-note">
              Every page has a Markdown twin and a JSON API behind it. Same data, no HTML. An agent asks with <code>Accept: text/markdown</code>, or adds <code>.md</code> to the URL.
            </p>
          </div>
          <div className="t-wrap">
            <div className="well-title">Ways to read it</div>
            <div className="inner rows">
              {all.map(request => (
                <div key={`${request.method} ${request.url}`} className="ep">
                  <span><span className={`method ${methodClass(request.method)}`.trim()}>{request.method}</span></span>
                  <span className="ep-url">
                    <code>{request.url}</code>
                    {request.note === undefined ? null : <span className="muted xs ep-note">{request.note}</span>}
                  </span>
                  <CopyButton text={request.url} label={`Copy ${request.url}`} variant="ghost" iconOnly />
                </div>
              ))}
            </div>
          </div>
          <Tabs
            label="How an agent reads this page"
            items={[
              { id: 'markdown', label: 'Markdown', content: <CodeBlock code={markdown} wrap tall /> },
              { id: 'json', label: 'JSON', content: <CodeBlock code={text} tall>{highlightJson(text)}</CodeBlock> },
              {
                id: 'curl',
                label: 'curl',
                content: (
                  <CodeBlock code={curl.join('\n\n')} wrap>
                    {curl.map((line, index) => <Fragment key={line}><span className="p">$</span> {line}{index < curl.length - 1 ? '\n\n' : ''}</Fragment>)}
                  </CodeBlock>
                ),
              },
            ]}
          />
          <p className="small muted">Switch back with <b>Human</b> in the header. The switch is kept in this browser.</p>
        </div>
      </div>
    </div>
  );
};

/**
 * A page's body that turns into its Agent view. `agent` is what the Agent view shows; `children` is the
 * page for people. The header's Human / Agent switch decides which one shows, and the choice is kept in
 * this browser. Put it inside `<main>`:
 *
 *     <PageView agent={{ title, markdown, json, requests, markdownUrl }}>…the page…</PageView>
 */
export const PageView = ({ agent, children }: { readonly agent: AgentViewProps; readonly children: ReactNode }) => {
  const view = useView();

  return view === 'agent' ? <AgentView {...agent} /> : <div className="page-human">{children}</div>;
};
