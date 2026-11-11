import { brandColors, markBox, markEyes, markRadius } from './mark';

/** The mark for an image response: inline SVG, which the image renderer draws. */
export const Mark = ({ size }: { readonly size: number }) => (
  <svg width={size} height={size} viewBox={`0 0 ${markBox} ${markBox}`}>
    <rect width={markBox} height={markBox} rx={markRadius} fill={brandColors.green} />
    <circle cx={markEyes.left} cy={markEyes.y} r={markEyes.r} fill={brandColors.ink} />
    <circle cx={markEyes.right} cy={markEyes.y} r={markEyes.r} fill={brandColors.ink} />
  </svg>
);
