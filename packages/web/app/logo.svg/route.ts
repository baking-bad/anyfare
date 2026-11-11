import { markSvg } from '../../src/brand/mark';

/** The mark as a vector file. */
export const GET = (): Response => new Response(markSvg(), {
  headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
});
