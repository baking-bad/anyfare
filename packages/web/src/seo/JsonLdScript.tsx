import { jsonLdText } from './jsonld';

/**
 * A JSON data block. The browser doesn't run it, so the policy's `script-src` doesn't apply to it. It carries
 * the request's nonce all the same, so every script tag of a page is one the policy names.
 */
export const JsonLd = ({ data, nonce }: { readonly data: Record<string, unknown>; readonly nonce: string | undefined }) => (
  <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
);
