import { Button } from '../src/components/Button';

/** A path with no page. */
const NotFound = () => (
  <section className="band">
    <div className="container ruled section">
      <div className="stack-lg">
        <span className="eyebrow">404</span>
        <h1 className="h2">Page not found</h1>
        <p className="lead">There is no page at this address.</p>
        <div className="row"><Button size="lg" href="/">Go to the home page</Button></div>
      </div>
    </div>
  </section>
);

export default NotFound;
