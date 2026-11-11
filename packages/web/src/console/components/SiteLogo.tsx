import { markBox, markShapes } from '../../brand/mark';

/**
 * The logo mark and the name, leading to the public site's home page. A plain link, never the router's: a page of the
 * public site loads as a page of its own, with its own layout and policy, even when the two hosts are one.
 */
export const SiteLogo = ({ siteUrl }: { readonly siteUrl: string }) => (
  <a className="logo" href={`${siteUrl}/`}>
    <svg aria-hidden="true" viewBox={`0 0 ${markBox} ${markBox}`}>
      {markShapes.map(shape => <path key={shape.fill} fill={shape.fill} d={shape.d} />)}
    </svg>
    anyfare
  </a>
);
