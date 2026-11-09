// What every read of a chain's RPC shares: a URL that may hold a key in its path or query, so only its
// host is ever printed, and a time limit that keeps no process alive.

/**
 * A text with every part of the RPC's URL taken out but its host: the URL, its path, its query, and
 * each of their parts. Any of them may hold a key.
 */
export function scrubRpcUrl(text: string, rpcUrl: string): string {
  let url: URL | undefined;
  try {
    url = new URL(rpcUrl);
  } catch {
    url = undefined;
  }
  const parts = [rpcUrl, url?.href, url === undefined ? undefined : `${url.origin}${url.pathname}`, url?.pathname, url?.search];
  for (const segment of url?.pathname.split('/') ?? []) {
    parts.push(segment);
    // A stray `%` is not an escape: the segment is scrubbed as it is
    try {
      parts.push(decodeURIComponent(segment));
    } catch {
      // Nothing more to scrub
    }
  }
  for (const [name, value] of url?.searchParams ?? []) parts.push(name, value);
  let scrubbed = text;
  for (const part of parts.filter((item): item is string => item !== undefined && item.length >= 2 && item !== '/')) {
    scrubbed = scrubbed.split(part).join('…');
  }
  return scrubbed;
}

/**
 * The reason of a `fetch` to `rpcUrl` that failed before any answer, in the error or its causes, as a
 * code, or a few plain words with nothing of the URL in them; `undefined` when there is none.
 */
export function fetchFailure(error: unknown, rpcUrl: string): string | undefined {
  let item: unknown = error;
  for (let depth = 0; item instanceof Error && depth < 5; depth += 1, item = item.cause) {
    if (item instanceof TypeError && item.message === 'fetch failed') {
      const cause = item.cause as { code?: unknown; message?: unknown } | undefined;
      if (typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(cause.code)) return cause.code;
      // A few plain words, such as "bad port", once anything of the URL is out of them
      const words = typeof cause?.message === 'string' ? scrubRpcUrl(cause.message, rpcUrl) : '';
      return /^[A-Za-z][A-Za-z ]{0,39}$/.test(words) ? words : '';
    }
  }
  return undefined;
}

/**
 * What `work` gives, or `'late'` when `limitMs` runs out first. Its failure after the limit is no
 * one's to hear, and the timer is cleared either way, so it keeps no process alive.
 */
export async function raceLimit<T>(work: Promise<T>, limitMs: number): Promise<T | 'late'> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), limitMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
