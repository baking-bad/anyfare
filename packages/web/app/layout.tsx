import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './tokens.css';
import './globals.css';
import './components.css';

import type { Metadata, Viewport } from 'next';
import { Suspense, type ReactNode } from 'react';

import { NavigationProgress } from '../src/components/NavigationProgress';
import { SettingsProvider } from '../src/components/Settings';
import { SiteFooter } from '../src/components/SiteFooter';
import { SiteHeader } from '../src/components/SiteHeader';
import { readSettings } from '../src/config';
import { consoleLink } from '../src/hosts';
import { requestNonce } from '../src/nonce';
import { sharedLinks } from '../src/seo/links';
import { requestSurface } from '../src/surface';
import { themeScript } from '../src/theme-script';

const description = 'Pay any paid API from the chain you are on. Or top up with any token and give your agent a key with a budget.';

// The console host's pages name that host as their base, so the icons load from it
export const generateMetadata = async (): Promise<Metadata> => ({
  metadataBase: new URL(await requestSurface() === 'console' ? readSettings().consoleUrl : readSettings().siteUrl),
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
  const settings = readSettings();
  const { siteUrl, consoleUrl, apiUrl, payUrl } = settings;
  // On the console host the header and the footer lead to the public site's pages, and the page has no links to the site's files
  const onConsole = await requestSurface() === 'console';
  const consoleHref = consoleLink(settings);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {(onConsole ? [] : sharedLinks(settings)).map(link => <link key={link.rel} rel={link.rel} href={link.href} {...link.type === undefined ? {} : { type: link.type }} {...link.title === undefined ? {} : { title: link.title }} />)}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <SettingsProvider value={{ apiUrl, payUrl, consoleUrl }}>
          <Suspense fallback={null}><NavigationProgress /></Suspense>
          <a className="skip-link" href="#main">Skip to the content</a>
          <SiteHeader consoleHref={consoleHref} {...onConsole ? { siteUrl } : {}} />
          <main id="main">{children}</main>
          <SiteFooter consoleHref={consoleHref} {...onConsole ? { base: siteUrl } : {}} />
        </SettingsProvider>
      </body>
    </html>
  );
};

export default RootLayout;
