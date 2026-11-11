import { formatUsd, type MicroUsd } from '@anyfare/common';
import { paymentMethodsFor, type PlatformConfig } from '@anyfare/core';
import type { CatalogCursor, RoutedCatalogEntry } from '@anyfare/db';

// What a page of the catalog shows of a routed endpoint, and its cursor, without a database

/** An endpoint of the catalog: unverified, priced at its last quote, linked on the pay host. */
export const catalogEntryOf = (entry: RoutedCatalogEntry, { payUrl, config }: { readonly payUrl: string; readonly config: PlatformConfig }) => {
  const price = entry.lastPrice ?? 0n as MicroUsd;

  return {
    id: `routed:${entry.host}${entry.path}`,
    host: entry.host,
    path: entry.path,
    title: `${entry.host}${entry.path}`,
    summary: entry.status === 'checked'
      ? 'A paid API a check found payable, that Anyfare routes payments to. No paid call has reached it yet. Unverified: its owner hasn\'t registered it.'
      : 'A paid API that Anyfare routes payments to. Unverified: its owner hasn\'t registered it.',
    priceFrom: formatUsd(price),
    currency: 'USD',
    methods: paymentMethodsFor(price, config),
    verified: false,
    status: entry.status,
    updatedAt: entry.createdAt.toISOString(),
    link: `${payUrl.replace(/\/+$/, '')}/${entry.host}${entry.path}`,
  };
};

// The longest a cursor gets: a key of a host of 259 bytes and a path of 2,048 printable ones, each escaped at most twice over
export const maxCursorLength = 8_192;

/** The cursor a page's `next` gives: the last endpoint it read, as base64url of JSON. Opaque to its reader. */
export const encodeCursor = (cursor: CatalogCursor): string =>
  Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.host, cursor.path])).toString('base64url');

// A host and a path as the routed endpoints keep them: a lowercase DNS name with an optional port, and printable ASCII
const cursorHost = /^(?=[^:]{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/;
const cursorPath = /^\/[\x21-\x7e]{0,2047}$/;

/** A cursor a page gave, or undefined for any other text, such as the offsets pages gave before, or a key no page could give. */
export const decodeCursor = (text: string): CatalogCursor | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  }
  catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 3 || !value.every(part => typeof part === 'string'))
    return undefined;
  const [at, host, path] = value as [string, string, string];
  const createdAt = new Date(at);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== at || !cursorHost.test(host) || !cursorPath.test(path))
    return undefined;

  return { createdAt, host, path };
};
