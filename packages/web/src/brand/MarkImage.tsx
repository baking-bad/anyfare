import { markBox, markShapes } from './mark';

/** The mark for an image response: inline SVG, which the image renderer draws. */
export const Mark = ({ size }: { readonly size: number }) => (
  <svg width={size} height={size} viewBox={`0 0 ${markBox} ${markBox}`}>
    {markShapes.map(shape => <path key={shape.fill} fill={shape.fill} d={shape.d} />)}
  </svg>
);
