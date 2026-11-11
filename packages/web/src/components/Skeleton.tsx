export type SkeletonShape = 'line' | 'title' | 'block';
export type SkeletonWidth = 'full' | 'lg' | 'md' | 'sm';

/** A loading placeholder that pulses. Sizes come from classes, so the page needs no inline style. */
export const Skeleton = ({ shape = 'line', width = 'full' }: { readonly shape?: SkeletonShape; readonly width?: SkeletonWidth }) => (
  <span className={`skeleton ${shape} w-${width}`} aria-hidden="true" />
);
