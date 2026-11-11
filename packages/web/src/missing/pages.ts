import { getReceipt } from '../api/endpoints';
import type { ApiResult, Reader } from '../api/reader';
import { isReceiptId, notFoundLine } from '../receipt/content';
import { checkHref, hostOfSegment, isHost, serviceMissingLine, serviceMissingTitle } from '../services/content';
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
  // A thing the visitor may have made a moment ago, by a check: with the check's marker in the address, a miss is read once more after a short wait
  readonly afterCheck?: boolean;
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
    valid: name => isHost(hostOfSegment(name)),
    exists: (read, name) => loadService(read, hostOfSegment(name), '30d'),
    afterCheck: true,
    title: serviceMissingTitle,
    line: serviceMissingLine,
    actions: name => [
      { label: 'See the services', href: '/services' },
      { label: 'Check this service', href: checkHref(hostOfSegment(name)), outline: true },
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

/** How often the thing is read again, for a visitor who has just made it by a check. */
export const recheckIntervalMs = 1_000;

/** How long in all a miss waits for the thing to be listed, for a visitor who has just made it by a check. */
export const recheckWindowMs = 5_000;

/** How many such waits may be going at once. Past it the visitor is told the thing is being listed, and the wait is theirs. */
export const maxRechecks = 20;

let rechecking = 0;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface MissingOptions {
  // The request carries the check's marker
  readonly afterCheck?: boolean;
  // Waits `ms`. A test passes its own.
  readonly pause?: (ms: number) => Promise<void>;
}

/**
 * What the thing is: `found`, `missing` (it can't exist, or the API says it doesn't), or `listing` (it may be
 * listed in a moment, and the wait for it is full). Any other failure is not "missing". For a page that allows
 * it and a request that carries the check's marker, the first answer of "not listed" is read again about
 * once a second, for 5 seconds in all, and the thing is `missing` only when the last read still says so.
 * At most 20 requests wait at a time: past that the answer is `listing` at once, so a flood of marked requests
 * can't hold the server.
 */
export const missingState = async (page: MissingPage, read: Reader, name: string, { afterCheck = false, pause = sleep }: MissingOptions = {}): Promise<'found' | 'missing' | 'listing'> => {
  if (!page.valid(name))
    return 'missing';
  const result = await page.exists(read, name);
  if (result.ok || result.error.status !== 404)
    return 'found';
  if (!afterCheck || page.afterCheck !== true)
    return 'missing';
  if (rechecking >= maxRechecks)
    return 'listing';
  rechecking += 1;
  try {
    for (let waited = 0; waited < recheckWindowMs; waited += recheckIntervalMs) {
      await pause(recheckIntervalMs);
      const again = await page.exists(read, name);
      if (again.ok || again.error.status !== 404)
        return 'found';
    }

    return 'missing';
  }
  finally {
    rechecking -= 1;
  }
};

/** Whether the thing is missing (see `missingState`). A full wait counts as not missing: the page answers for it. */
export const isMissing = async (page: MissingPage, read: Reader, name: string, options: MissingOptions = {}): Promise<boolean> =>
  await missingState(page, read, name, options) === 'missing';

/** The page the visitor gets when the wait for a just-checked thing is full: it says the thing is being listed. */
export const listingPath = '/_/listing';

/** What that page says. */
export const listingTitle = 'This service is being listed';
export const listingLine = 'This service is being listed. Reload in a moment.';
