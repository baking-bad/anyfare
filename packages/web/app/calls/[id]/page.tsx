import '../../receipt.css';

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

import { serverReader } from '../../../src/api/server';
import { PageView } from '../../../src/components/AgentView';
import { readSettings } from '../../../src/config';
import { receiptMarkdown, receiptUnavailableMarkdown } from '../../../src/markdown/receipt';
import { socialTags } from '../../../src/seo/social';
import { markdownUrl } from '../../../src/markdown/negotiate';
import { isReceiptId, receiptDescription, receiptTitle } from '../../../src/receipt/content';
import { loadReceipt, receiptRequests } from '../../../src/receipt/data';
import { ReceiptUnavailable } from '../../../src/receipt/ReceiptUnavailable';
import { ReceiptView } from '../../../src/receipt/ReceiptView';

type Params = { readonly params: Promise<{ readonly id: string }> };

export const generateMetadata = async ({ params }: Params): Promise<Metadata> => {
  const { id } = await params;
  const { siteUrl } = readSettings();
  const url = `${siteUrl}/calls/${encodeURIComponent(id)}`;
  const title = receiptTitle(id);

  return {
    title,
    description: receiptDescription,
    // A receipt is one of many thin pages
    robots: { index: false, follow: true },
    alternates: { canonical: url, types: { 'text/markdown': `${siteUrl}${markdownUrl(`/calls/${encodeURIComponent(id)}`)}` } },
    ...socialTags({ siteUrl, title: `${title} | Anyfare`, description: receiptDescription, url }),
  };
};

/**
 * The receipt of one call. proxy.ts has already answered an id that isn't one and an unknown call with
 * the 404 page. A read that fails otherwise, such as the API being down, shows the error state: a page
 * can't choose a status other than 404, and the twin answers 503.
 */
const Receipt = async ({ params }: Params) => {
  const { id } = await params;
  if (!isReceiptId(id))
    notFound();
  const settings = readSettings();
  const result = await loadReceipt(serverReader(await headers(), settings), id);
  if (!result.ok && result.error.status === 404)
    notFound();

  const agentUrl = `${settings.siteUrl}${markdownUrl(`/calls/${id}`)}`;

  return (
    <PageView
      agent={{
        title: receiptTitle(id),
        markdown: result.ok ? receiptMarkdown(settings, result.value) : receiptUnavailableMarkdown(),
        json: result.ok ? result.value : { error: { code: result.error.code, message: result.error.message } },
        requests: receiptRequests(settings, id),
        markdownUrl: agentUrl,
      }}
    >
      <section className="band">
        <div className="container ruled page-pad receipt-container">
          {result.ok
            ? <ReceiptView receipt={result.value} siteUrl={settings.siteUrl} />
            : <ReceiptUnavailable />}
        </div>
      </section>
    </PageView>
  );
};

export default Receipt;
