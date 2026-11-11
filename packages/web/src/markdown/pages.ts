import type { Reader } from '../api/reader';
import type { SiteSettings } from '../config';
import { loadHome } from '../home/data';
import { homeMarkdown } from './home';

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

export interface MarkdownPage {
  readonly pattern: RegExp;
  readonly render: (context: MarkdownContext) => Promise<string>;
}

export const markdownPages: readonly MarkdownPage[] = [
  { pattern: /^\/$/, render: async ({ settings, read }) => homeMarkdown(settings, await loadHome(read)) },
];

/** The entry for an HTML page, when it has a Markdown twin. */
export const markdownPageFor = (path: string): MarkdownPage | undefined => markdownPages.find(page => page.pattern.test(path));
