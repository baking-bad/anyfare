'use client';

import { Button } from '../src/components/Button';

/** A page whose data didn't load, such as while the Platform API is down. No detail leaks. */
const PageError = ({ reset }: { readonly error: Error; readonly reset: () => void }) => (
  <section className="band">
    <div className="container ruled section">
      <div className="stack-lg">
        <span className="eyebrow">Something went wrong</span>
        <h1 className="h2">This page didn&apos;t load</h1>
        <p className="lead">Try again in a moment. If it keeps failing, the Platform API may be down.</p>
        <div className="row">
          <Button size="lg" href="/">Go to the home page</Button>
          <Button size="lg" variant="outline" onClick={reset}>Try again</Button>
        </div>
      </div>
    </div>
  </section>
);

export default PageError;
