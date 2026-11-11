'use client';

import { useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { createReader } from '../api/reader';
import { deriveAgent, twinKeyOf, type AgentSource } from './agentSource';
import { Button } from './Button';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import { highlightJson, jsonText } from './Json';
import { useSettings } from './Settings';
import { Skeleton } from './Skeleton';
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
  // Request headers it needs, such as `X-Anyfare-Check: 1`
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * What an agent gets of a page. A page builds this and hands it to `PageView`.
 *
 * - `title`: the page's title.
 * - `markdown`: the page as Markdown.
 * - `json`: the page's data, any JSON value.
 * - `requests`: the requests behind the page. They are listed above the tabs, with a copy button each.
 * - `markdownUrl`: the full URL of the page's Markdown twin, with the query of the page as the server read it.
 *   It is listed first among the requests.
 * - `source`: which page this is, for a page whose data follows its address (see agentSource.ts). Omitted for
 *   a page that doesn't change with its query.
 * - `readAt`: when the server read the data, in milliseconds. The view says when it was read.
 *
 * When the address changes in the browser (a filter, a page, a period or a sort), the Agent view reads the
 * page's Markdown again from the site's own twin URL, and reads the data again from the public API to
 * rebuild the JSON and the requests with the builders the server uses. While it reads it shows a loading
 * state, and a failed read shows an error state; it never shows the data of another address.
 */
export interface AgentViewProps {
  readonly title: string;
  readonly markdown: string;
  readonly json: unknown;
  readonly requests: readonly AgentRequest[];
  readonly markdownUrl: string;
  readonly source?: AgentSource;
  readonly readAt?: number;
}

const methodClass = (method: string): string => ({ GET: 'get', POST: 'post', SSE: 'sse', DELETE: 'del' } as Record<string, string>)[method] ?? '';

// The page's own address from its Markdown twin's: `/index.md` is `/`, `/services.md` is `/services`
const pageUrlOf = (markdownUrl: string): string => {
  const [path = '', ...query] = markdownUrl.split('?');
  const page = path.endsWith('/index.md') ? path.slice(0, -'index.md'.length) : path.replace(/\.md$/, '');

  return query.length === 0 ? page : `${page}?${query.join('?')}`;
};

// Read requests an agent can run as they are: the page by Accept, its twin, and the first request behind it
const curlLines = (markdownUrl: string, requests: readonly AgentRequest[]): readonly string[] => {
  const first = requests.find(request => request.method === 'GET');

  return [
    `curl -H "Accept: text/markdown" ${pageUrlOf(markdownUrl)}`,
    `curl ${markdownUrl}`,
    ...first === undefined ? [] : [`curl ${first.url}${Object.entries(first.headers ?? {}).map(([name, value]) => ` -H "${name}: ${value}"`).join('')}`],
  ];
};

interface Reading {
  // The twin's path and query this was read for
  readonly key: string;
  readonly markdown: string;
  readonly json: unknown;
  readonly requests: readonly AgentRequest[];
  readonly readAt: number;
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);

/** The page the way an agent reads it: the requests behind it, then its Markdown, JSON and curl, each with a copy button. */
export const AgentView = ({ title, markdown, json, requests, markdownUrl, source = { kind: 'static' }, readAt }: AgentViewProps) => {
  const { apiUrl, payUrl } = useSettings();
  const params = useSearchParams();
  const origin = useMemo(() => new URL(markdownUrl).origin, [markdownUrl]);
  const initialKey = markdownUrl.slice(origin.length);
  const key = source.kind === 'static' ? initialKey : twinKeyOf(source, initialKey, params);
  const initial = useMemo<Reading>(() => ({ key: initialKey, markdown, json, requests, readAt: readAt ?? 0 }), [initialKey, markdown, json, requests, readAt]);

  // What was read in the browser, and what failed, each for one address
  const [read, setRead] = useState<Reading | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [again, setAgain] = useState(0);
  const current = read?.key === key ? read : key === initialKey && again === 0 ? initial : undefined;
  const failedHere = current === undefined && failed === `${key}#${again}`;

  const needsRead = current === undefined && !failedHere;
  useEffect(() => {
    if (!needsRead)
      return undefined;
    let cancelled = false;
    const reader = createReader({ apiUrl });
    const search = new URLSearchParams(window.location.search);
    void Promise.all([
      fetch(key, { headers: { accept: 'text/markdown' } }).then(async response => {
        if (!response.ok && response.status !== 404 && response.status !== 503)
          throw new Error('The twin did not answer');

        return response.text();
      }),
      deriveAgent(source, reader, { apiUrl, payUrl }, search),
    ]).then(([text, derived]) => {
      if (cancelled)
        return;
      setRead({ key, markdown: text, json: derived?.json ?? json, requests: derived?.requests ?? requests, readAt: Date.now() });
    }).catch(() => {
      if (!cancelled)
        setFailed(`${key}#${again}`);
    });

    return () => {
      cancelled = true;
    };
    // `source`, `json` and `requests` are the server's and change only with a new page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, again, needsRead]);

  const readAgain = useCallback((): void => {
    setRead(undefined);
    setFailed(undefined);
    setAgain(count => count + 1);
  }, []);

  const loading = needsRead;
  const shown = current ?? initial;
  const text = jsonText(shown.json);
  const all: readonly AgentRequest[] = [{ method: 'GET', url: `${origin}${shown.key}`, note: 'This page as Markdown' }, ...shown.requests];
  const curl = curlLines(`${origin}${shown.key}`, shown.requests);
  const placeholder = <div className="stack" role="status" aria-label="Reading the page"><Skeleton shape="block" /><Skeleton shape="block" /></div>;
  const problem = (
    <div className="alert danger" role="alert">
      <Icon name="alert" />
      <div className="stack">
        <span className="t">This didn&apos;t load</span>
        <span>The page couldn&apos;t be read again. What was shown before is for another address, so it is hidden.</span>
        <div className="mt-8"><Button variant="secondary" size="sm" onClick={readAgain}>Try again</Button></div>
      </div>
    </div>
  );

  return (
    <div className="band">
      <div className="container ruled agent-view" aria-busy={loading}>
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
              {failedHere ? problem : loading ? placeholder : all.map(request => (
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
              { id: 'markdown', label: 'Markdown', content: failedHere ? problem : loading ? placeholder : <CodeBlock code={shown.markdown} wrap tall /> },
              { id: 'json', label: 'JSON', content: failedHere ? problem : loading ? placeholder : <CodeBlock code={text} tall>{highlightJson(text)}</CodeBlock> },
              {
                id: 'curl',
                label: 'curl',
                content: failedHere ? problem : loading ? placeholder : (
                  <CodeBlock code={curl.join('\n\n')} wrap>
                    {curl.map((line, index) => <Fragment key={line}><span className="p">$</span> {line}{index < curl.length - 1 ? '\n\n' : ''}</Fragment>)}
                  </CodeBlock>
                ),
              },
            ]}
          />
          <div className="row small muted">
            <span>Switch back with <b>Human</b> in the header. The switch is kept in this browser.</span>
            {shown.readAt > 0 && !loading && !failedHere ? (
              <>
                <span role="status">Read at {clock(shown.readAt)} UTC.</span>
                {source.kind === 'static' ? null : <Button variant="ghost" size="sm" onClick={readAgain}>Read again</Button>}
              </>
            ) : null}
          </div>
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
