import Link from 'next/link';

import { markBox, markShapes } from '../brand/mark';

/** The logo mark and the name, linking home. `href` is the site's home when the page is on another host. */
export const Logo = ({ href = '/' }: { readonly href?: string }) => (
  <Link className="logo" href={href}>
    <svg aria-hidden="true" viewBox={`0 0 ${markBox} ${markBox}`}>
      {markShapes.map(shape => <path key={shape.fill} fill={shape.fill} d={shape.d} />)}
    </svg>
    anyfare
  </Link>
);
