import { payReader, serverReader } from '../../../src/api/server';
import { readSettings } from '../../../src/config';
import { defaultMaxAge, markdownPageFor } from '../../../src/markdown/pages';

export const dynamic = 'force-dynamic';

const headers = { 'content-type': 'text/markdown; charset=utf-8' };

const notFound = (): Response => new Response('# Not found\n', { status: 404, headers });

/**
 * The Markdown twin of a public page. proxy.ts rewrites `<page>.md`, and a page asked for with
 * `Accept: text/markdown`, to `/md/<page>`.
 */
export const GET = async (request: Request, { params }: { readonly params: Promise<{ readonly path?: readonly string[] }> }): Promise<Response> => {
  const path = `/${((await params).path ?? []).join('/')}`;
  const page = markdownPageFor(path);
  if (page === undefined)
    return notFound();

  const settings = readSettings();
  const answer = await page.render({ settings, read: serverReader(request.headers, settings), payRead: payReader(request.headers, settings), path, search: new URL(request.url).searchParams });
  if (typeof answer !== 'string')
    return new Response(answer.body, { status: answer.status, headers: { ...headers, 'cache-control': 'no-store', vary: 'Accept' } });

  return new Response(answer, { headers: { ...headers, 'cache-control': `public, max-age=${page.maxAge ?? defaultMaxAge}`, vary: 'Accept' } });
};
