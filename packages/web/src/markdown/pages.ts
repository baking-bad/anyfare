import type { Reader } from '../api/reader';
import type { SiteSettings } from '../config';
import { loadCalls } from '../calls/data';
import { parseFilters } from '../calls/filters';
import { loadHome } from '../home/data';
import { callsMarkdown } from './calls';
import { notFoundLine } from '../receipt/content';
import { loadReceipt } from '../receipt/data';
import { homeMarkdown } from './home';
import { receiptMarkdown, receiptUnavailableMarkdown } from './receipt';

// Every public page has a Markdown twin: its URL with `.md`, or its own URL asked for with
// `Accept: text/markdown`. This list is the only place that knows which pages have one.
//
// To give a page a twin, add one entry: the `pattern` of the page's path, and a `render` that reads
// the page's data with `read` and returns its Markdown. Use the same loader the page uses, so both
// say the same.

export interface MarkdownContext {
  readonly settings: SiteSettings;
  readonly read: Reader;
  // The page's path, such as `/` or `/services/example.com`
  readonly path: string;
  // The page's query, as asked for
  readonly search: URLSearchParams;
}

/** A twin that answers with a status of its own, such as 404 for an unknown call. */
export interface MarkdownAnswer {
  readonly status: number;
  readonly body: string;
}

export interface MarkdownPage {
  readonly pattern: RegExp;
  readonly render: (context: MarkdownContext) => Promise<string | MarkdownAnswer>;
}

export const markdownPages: readonly MarkdownPage[] = [
  { pattern: /^\/$/, render: async ({ settings, read }) => homeMarkdown(settings, await loadHome(read)) },
  {
    pattern: /^\/calls$/,
    render: async ({ settings, read, search }) => {
      const filters = parseFilters(search);

      return callsMarkdown(settings, await loadCalls(read, filters), filters);
    },
  },
  {
    pattern: /^\/calls\/[A-Za-z0-9_-]{1,64}$/,
    render: async ({ settings, read, path }) => {
      const id = path.slice('/calls/'.length);
      const result = await loadReceipt(read, id);
      if (result.ok)
        return receiptMarkdown(settings, result.value);

      return result.error.status === 404
        ? { status: 404, body: `# Not found\n\n${notFoundLine}\n` }
        : { status: 503, body: receiptUnavailableMarkdown() };
    },
  },
];

/** The entry for an HTML page, when it has a Markdown twin. */
export const markdownPageFor = (path: string): MarkdownPage | undefined => markdownPages.find(page => page.pattern.test(path));
