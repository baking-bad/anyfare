import { headers } from 'next/headers';
import type { Metadata } from 'next';

import { Button } from '../src/components/Button';
import { missingKindHeader, missingNameHeader, missingPageOfKind } from '../src/missing/pages';

const decoded = (value: string | null): string => {
  try {
    return decodeURIComponent(value ?? '');
  }
  catch {
    return '';
  }
};

const notFoundTitle = 'Page not found';

/** The title of the 404 page is the thing's own ("Service not found"), and no search engine keeps it. */
export const generateMetadata = async (): Promise<Metadata> => {
  const missing = missingPageOfKind((await headers()).get(missingKindHeader));

  return { title: missing?.title ?? notFoundTitle, robots: { index: false, follow: false } };
};

/** A path with no page. A thing that doesn't exist, such as a call or a service, is told apart by the headers proxy.ts sets. */
const NotFound = async () => {
  const incoming = await headers();
  const missing = missingPageOfKind(incoming.get(missingKindHeader));
  const name = decoded(incoming.get(missingNameHeader));
  const actions = missing?.actions(name) ?? [{ label: 'Go to the home page', href: '/' }];

  return (
    // The Human / Agent switch has nothing to switch here (see components.css), so the header hides it
    <section className="band no-agent-view">
      <div className="container ruled section">
        <div className="stack-lg">
          <span className="eyebrow">404</span>
          <h1 className="h2">{missing?.title ?? notFoundTitle}</h1>
          <p className="lead">{missing?.line ?? 'There is no page at this address.'}</p>
          <div className="row">
            {actions.map(action => <Button key={action.href} size="lg" href={action.href} {...action.outline ? { variant: 'outline' as const } : {}}>{action.label}</Button>)}
          </div>
        </div>
      </div>
    </section>
  );
};

export default NotFound;
