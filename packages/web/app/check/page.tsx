import '../calls.css';
import '../check.css';

import { headers } from 'next/headers';
import type { Metadata } from 'next';

import { payReader, serverReader } from '../../src/api/server';
import { PageView } from '../../src/components/AgentView';
import { readSettings } from '../../src/config';
import { CheckForm } from '../../src/check/CheckForm';
import { CheckEmpty, CheckPayable, CheckRefused, CheckUnavailable } from '../../src/check/CheckView';
import { checkAddress, checkDescription, defaultMethod, maxFieldLength, parseCheckParams, titleFor, unavailableLine, unavailableTitle } from '../../src/check/content';
import { checkJson, checkRequests, loadCheckData } from '../../src/check/data';
import { checkMarkdown } from '../../src/markdown/check';
import { socialTags } from '../../src/seo/social';
import { markdownUrl } from '../../src/markdown/negotiate';

type Props = { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> };

export const generateMetadata = async ({ searchParams }: Props): Promise<Metadata> => {
  const { url, method } = parseCheckParams(await searchParams);
  const { siteUrl } = readSettings();
  const title = titleFor(url, method);

  return {
    title,
    description: checkDescription,
    // A check is for the one who pasted the link: the page is not for a search engine
    robots: { index: false, follow: false },
    alternates: { canonical: `${siteUrl}/check${method === defaultMethod ? '' : `?method=${method}`}`, types: { 'text/markdown': `${siteUrl}${checkAddress({ url, method, tab: 'overview', period: '30d', page: 1 }, markdownUrl('/check'))}` } },
    ...socialTags({ siteUrl, title: `${title} | Anyfare`, description: checkDescription }),
  };
};

const hostOf = (url: string): string => new URL(url).host;

/**
 * The result of checking a link. The link comes from the URL (`?url=`), the tab, the period and the page of
 * calls too. The server asks the pay host to check the link and never requests the link itself. Each part
 * that reads the API survives alone: a failed read shows its own error state, and the field above stays usable.
 */
const Check = async ({ searchParams }: Props) => {
  const params = parseCheckParams(await searchParams);
  const settings = readSettings();
  const incoming = await headers();
  const data = await loadCheckData(payReader(incoming, settings), serverReader(incoming, settings), params);
  const { state } = data;
  const twin = checkMarkdown(settings, data);
  const agentUrl = `${settings.siteUrl}${checkAddress({ url: params.url, method: params.method, tab: 'overview', period: '30d', page: 1 }, markdownUrl('/check'))}`;

  return (
    <PageView
      agent={{
        title: titleFor(params.url, params.method),
        markdown: twin.body,
        json: checkJson(data),
        requests: checkRequests(settings, data),
        markdownUrl: agentUrl,
      }}
    >
      <section className="band">
        <div className="container ruled check-top">
          <CheckForm value={params.url.slice(0, maxFieldLength)} method={params.method} label="Check again" />
        </div>
      </section>
      <section className="band">
        <div className="container ruled page-pad">
          {state.kind === 'empty' ? <CheckEmpty />
            : state.kind === 'refused' ? <CheckRefused refusal={state.refusal} url={params.url} method={params.method} />
              : state.kind === 'unavailable' ? <CheckUnavailable title={unavailableTitle}>{unavailableLine}</CheckUnavailable>
                : (
                  <CheckPayable
                    check={state.check}
                    raw={state.raw}
                    stats={data.stats!}
                    calls={data.calls!}
                    params={params}
                    now={Date.now()}
                    payHost={hostOf(settings.payUrl)}
                    consoleUrl={settings.consoleUrl}
                  />
                )}
        </div>
      </section>
    </PageView>
  );
};

export default Check;
