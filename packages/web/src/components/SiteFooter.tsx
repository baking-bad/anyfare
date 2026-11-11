import Link from 'next/link';

import { llmsPath, skillPath } from '../agents/links';
import { Logo } from './Logo';

/**
 * The footer: the logo and a line, three link columns, and the last line. "Read our post" has no target yet.
 * `base` is the site's origin when the page is on the console host: the links then lead to the public site.
 */
export const SiteFooter = ({ consoleHref, base = '' }: { readonly consoleHref: string; readonly base?: string }) => (
  <footer className="site-footer">
    <div className="container">
      <div className="footer-grid">
        <div className="stack">
          <Logo href={`${base}/`} />
          <p className="small about">Any coin pays any fare. Pay any paid API from the chain you are on. Or top up with any token.</p>
        </div>
        <div>
          <h4>Product</h4>
          <ul>
            <li><Link href={`${base}/`}>Check a link</Link></li>
            <li><Link href={`${base}/services`}>Services</Link></li>
            <li><Link href={`${base}/calls`}>Calls</Link></li>
            <li><a href={consoleHref}>Console</a></li>
          </ul>
        </div>
        <div>
          <h4>Agents</h4>
          <ul>
            <li><Link href={`${base}/agents`}>For agents</Link></li>
            <li><a href={`${base}${llmsPath}`}>llms.txt</a></li>
            <li><Link href={`${base}/agents#api`}>Platform API</Link></li>
            <li><a href={`${base}${skillPath}`}>Agent skill</a></li>
          </ul>
        </div>
        <div>
          <h4>Connect</h4>
          <ul>
            <li><a href="https://x.com/3route_io">X</a></li>
            <li><a href="mailto:hello@bakingbad.dev">Email</a></li>
            <li><a href="https://github.com/baking-bad/anyfare">GitHub</a></li>
          </ul>
        </div>
      </div>
      <p className="xs footer-last">
        © 2026 Anyfare. Built by the <a className="inline" href="https://3route.io">3Route</a> team at <a className="inline" href="https://bakingbad.dev">Baking Bad</a> for the <a className="inline" href="https://nearhackathon.com">NEAR Hackathon</a>. Read our post
      </p>
    </div>
  </footer>
);
