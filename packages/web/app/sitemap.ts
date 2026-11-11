import type { MetadataRoute } from 'next';

import { logApiFailure } from '../src/api/failures';
import { createReader } from '../src/api/reader';
import { readSettings } from '../src/config';
import { sitemapEntries } from '../src/seo/sitemap';

export const dynamic = 'force-dynamic';

// How long the sitemap waits for the API: a slow API leaves the static pages alone
const timeoutMs = 5_000;

const sitemap = async (): Promise<MetadataRoute.Sitemap> => {
  const settings = readSettings();
  const read = createReader({ apiUrl: settings.apiInternalUrl, timeoutMs, onFailure: logApiFailure() });

  return [...await sitemapEntries(settings, read)];
};

export default sitemap;
