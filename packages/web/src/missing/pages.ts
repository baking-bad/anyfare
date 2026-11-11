import { getReceipt } from '../api/endpoints';
import type { ApiResult, Reader } from '../api/reader';
import { isReceiptId, notFoundLine } from '../receipt/content';
import { checkHref, isHost, serviceMissingLine, serviceMissingTitle } from '../services/content';
import { loadService } from '../services/data';

// The pages whose address holds a thing that may not exist, such as a call or a service. A page's
// `notFound()` doesn't render on the server here: it streams a bare shell that only scripts fill in. So
// proxy.ts decides before the page runs. For an address that matches a `pattern`, it asks `exists`, and
// answers the 404 page with that page's wording, whose status is 404 and whose text is server-rendered.
//
// To give a page this, add one entry: the `pattern` of its path (the group is the address's thing), how
// to tell a thing that can't exist without asking (`valid`), how to ask the API (`exists`), and the words.

export interface MissingAction {
  readonly label: string;
  readonly href: string;
  readonly outline?: boolean;
}

export interface MissingPage {
  readonly kind: string;
  // On the path. Group 1 is the thing's name in the address.
  readonly pattern: RegExp;
  // A name that can't be a thing is missing without asking the API
  readonly valid: (name: string) => boolean;
  // The API's answer for the thing: a 404 means it doesn't exist. Any other failure is the page's to show.
  readonly exists: (read: Reader, name: string) => Promise<ApiResult<unknown>>;
  readonly title: string;
  readonly line: string;
  readonly actions: (name: string) => readonly MissingAction[];
}

export const missingPages: readonly MissingPage[] = [
  {
    kind: 'receipt',
    pattern: /^\/calls\/([^/]+)$/,
    valid: isReceiptId,
    exists: getReceipt,
    title: 'Receipt not found',
    line: notFoundLine,
    actions: () => [{ label: 'See the calls', href: '/calls' }],
  },
  {
    kind: 'service',
    pattern: /^\/services\/([^/]+)$/,
    valid: isHost,
    exists: (read, name) => loadService(read, name, '30d'),
    title: serviceMissingTitle,
    line: serviceMissingLine,
    actions: name => [
      { label: 'See the services', href: '/services' },
      { label: 'Check this service', href: checkHref(name), outline: true },
    ],
  },
];

/** The path every missing thing is rewritten to, with its kind after it: a path with no page, so the 404 page answers. */
export const missingPath = '/_/missing';

/** Request headers the proxy sets for the 404 page: what is missing, and its name. A visitor can't set them. */
export const missingKindHeader = 'x-missing-kind';
export const missingNameHeader = 'x-missing-name';

/** The longest name the 404 page repeats. */
export const maxMissingName = 200;

/** The entry whose pattern the path matches, with the thing's name from the address. */
export const missingPageFor = (pathname: string): { readonly page: MissingPage; readonly name: string } | undefined => {
  for (const page of missingPages) {
    const name = page.pattern.exec(pathname)?.[1];
    if (name !== undefined)
      return { page, name };
  }

  return undefined;
};

export const missingPageOfKind = (kind: string | null): MissingPage | undefined => missingPages.find(page => page.kind === kind);

/** Whether the thing is missing: it can't exist, or the API says it doesn't. Any other failure is not "missing". */
export const isMissing = async (page: MissingPage, read: Reader, name: string): Promise<boolean> => {
  if (!page.valid(name))
    return true;
  const result = await page.exists(read, name);

  return !result.ok && result.error.status === 404;
};
