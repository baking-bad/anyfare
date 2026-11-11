import type { Metadata } from 'next';

// A page's Open Graph and Twitter tags: its own title and description, and the share image. The image is named
// here, with an absolute URL: a page that sets its own tags doesn't inherit the app's image files.

export const shareImageUrl = (siteUrl: string): string => `${siteUrl}/opengraph-image`;
export const shareImageAlt = 'Anyfare: Pay any paid API from the chain you are on.';

export interface SocialInput {
  // The site's origin: the share image is served from it
  readonly siteUrl: string;
  readonly title: string;
  readonly description: string;
  // The page's canonical URL
  readonly url?: string;
}

export const socialTags = ({ siteUrl, title, description, url }: SocialInput): Pick<Metadata, 'openGraph' | 'twitter'> => ({
  openGraph: { type: 'website', siteName: 'Anyfare', title, description, ...url === undefined ? {} : { url }, images: [{ url: shareImageUrl(siteUrl), width: 1200, height: 630, type: 'image/png', alt: shareImageAlt }] },
  twitter: { card: 'summary_large_image', title, description, images: [{ url: shareImageUrl(siteUrl), alt: shareImageAlt }] },
});
