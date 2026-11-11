import type { Metadata } from 'next';

import { Button } from '../../../src/components/Button';
import { fromCheckName, fromCheckValue, hostOfSegment, isHost, servicePath } from '../../../src/services/content';
import { listingLine, listingTitle, maxMissingName } from '../../../src/missing/pages';

export const generateMetadata = (): Metadata => ({ title: listingTitle, robots: { index: false, follow: false } });

export const dynamic = 'force-dynamic';

/**
 * Where proxy.ts sends a visitor who has just checked a link, when too many others are waiting for their
 * service to be listed. It answers 200: the service is likely to exist in a moment. The button reads the page again.
 */
const Listing = async ({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) => {
  const raw = (await searchParams)['name'];
  const name = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, maxMissingName) ?? '';
  const host = hostOfSegment(name);
  const href = isHost(host) ? `${servicePath(host)}?${fromCheckName}=${fromCheckValue}` : '/services';

  return (
    <section className="band no-agent-view">
      <div className="container ruled section">
        <div className="stack-lg">
          <span className="eyebrow">Listing</span>
          <h1 className="h2">{listingTitle}</h1>
          <p className="lead">{listingLine}</p>
          <div className="row">
            <Button size="lg" href={href}>Reload</Button>
            <Button size="lg" variant="outline" href="/services">See the services</Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Listing;
