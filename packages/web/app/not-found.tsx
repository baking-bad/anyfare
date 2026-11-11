import { headers } from 'next/headers';

import { Button } from '../src/components/Button';
import { missingHeader } from '../src/receipt/data';
import { notFoundLine } from '../src/receipt/content';

/** A path with no page. A receipt that doesn't exist is told apart by the header proxy.ts sets. */
const NotFound = async () => {
  const receipt = (await headers()).get(missingHeader) === '1';

  return (
    <section className="band">
      <div className="container ruled section">
        <div className="stack-lg">
          <span className="eyebrow">404</span>
          <h1 className="h2">{receipt ? 'Receipt not found' : 'Page not found'}</h1>
          <p className="lead">{receipt ? notFoundLine : 'There is no page at this address.'}</p>
          <div className="row"><Button size="lg" href={receipt ? '/calls' : '/'}>{receipt ? 'See the calls' : 'Go to the home page'}</Button></div>
        </div>
      </div>
    </section>
  );
};

export default NotFound;
