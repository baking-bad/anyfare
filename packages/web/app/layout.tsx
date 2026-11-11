import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './tokens.css';
import './globals.css';
import './components.css';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { SiteFooter } from '../src/components/SiteFooter';
import { SiteHeader } from '../src/components/SiteHeader';
import { readSettings } from '../src/config';
import { requestNonce } from '../src/nonce';
import { themeScript } from '../src/theme-script';

const description = 'Pay any paid API from the chain you are on. Or top up with any token and give your agent a key with a budget.';

export const generateMetadata = (): Metadata => ({
  metadataBase: new URL(readSettings().siteUrl),
  title: { default: 'Anyfare: pay any paid API from the chain you are on', template: '%s | Anyfare' },
  description,
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1f1f1f' },
  ],
};

const RootLayout = async ({ children }: { readonly children: ReactNode }) => {
  const nonce = await requestNonce();
  const { consoleUrl } = readSettings();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a className="skip-link" href="#main">Skip to the content</a>
        <SiteHeader consoleUrl={consoleUrl} />
        <main id="main">{children}</main>
        <SiteFooter consoleUrl={consoleUrl} />
      </body>
    </html>
  );
};

export default RootLayout;
