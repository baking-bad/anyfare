import { logoSvg } from '../../../../src/brand/logos';

/** A network's or a token's logo: `/logos/networks/near.svg`, `/logos/tokens/usdc.svg`. */
export const GET = async (_request: Request, { params }: { readonly params: Promise<{ readonly kind: string; readonly file: string }> }): Promise<Response> => {
  const { kind, file } = await params;
  const svg = logoSvg(kind, file);

  return svg === undefined
    ? new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    : new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
};
