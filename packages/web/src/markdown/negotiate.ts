import { markdownPageFor } from './pages';

// Which URLs and requests ask for a page's Markdown twin. The pages that have one are listed in pages.ts.

export const markdownRoot = '/md';

/** Whether an HTML page has a Markdown twin. */
export const hasMarkdown = (pathname: string): boolean => markdownPageFor(pathname) !== undefined;

/** The page a `.md` URL stands for: `/index.md` is `/`, `/services.md` is `/services`. */
export const pageForMarkdownUrl = (pathname: string): string | undefined => {
  if (pathname === '/index.md')
    return '/';
  const page = pathname.endsWith('.md') ? pathname.slice(0, -'.md'.length) : '';

  return page !== '' && page !== '/' && hasMarkdown(page) ? page : undefined;
};

/** Where a page's Markdown is rendered. */
export const markdownRoute = (page: string): string => page === '/' ? markdownRoot : `${markdownRoot}${page}`;

/** A page's public Markdown path, such as `/services.md`. */
export const markdownUrl = (page: string): string => page === '/' ? '/index.md' : `${page}.md`;

const quality = (range: string, accept: readonly { readonly type: string; readonly q: number }[]): number =>
  accept.find(entry => entry.type === range)?.q ?? 0;

/** Whether an Accept header asks for Markdown over HTML, such as `text/markdown` or `text/markdown, text/html;q=0.5`. */
export const prefersMarkdown = (header: string | null | undefined): boolean => {
  if (!header)
    return false;
  const accept = header.split(',').map(part => {
    const [type = '', ...parameters] = part.split(';').map(piece => piece.trim().toLowerCase());
    const q = parameters.find(parameter => parameter.startsWith('q='));

    return { type, q: q === undefined ? 1 : Number(q.slice(2)) || 0 };
  });
  const markdown = quality('text/markdown', accept);

  return markdown > 0 && markdown > quality('text/html', accept);
};
