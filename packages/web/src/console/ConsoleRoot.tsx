'use client';

import { useMemo, type ReactNode } from 'react';

import { ToastProvider } from './components/Toast';
import { ConsoleDataProvider, ConsolePlacesProvider } from './context';
import { Opening } from './ConsolePage';
import { Frame } from './Frame';
import { RotationProvider } from './Rotation';
import { useSession } from './session';

/**
 * The console around its pages. The server knows nothing of the session, so its HTML is a spinner and holds no
 * account data; the browser reads the session and shows the frame and the page, or the page's sign-in view. The
 * frame, and every read it made, goes on sign-out.
 */
export const ConsoleRoot = ({ siteUrl, overviewPath, children }: { readonly siteUrl: string; readonly overviewPath: string; readonly children: ReactNode }) => {
  const session = useSession();
  const places = useMemo(() => ({ siteUrl, overviewPath }), [siteUrl, overviewPath]);

  return (
    <ConsolePlacesProvider value={places}>
      <ToastProvider>
        {/* Above the sign-in switch: a rotation's new key shows even when the session ended while it ran */}
        <RotationProvider>
          {session.status === 'unknown' ? <Opening /> : session.status === 'signedIn' ? (
            <ConsoleDataProvider>
              <Frame masked={session.key}>{children}</Frame>
            </ConsoleDataProvider>
          ) : children}
        </RotationProvider>
      </ToastProvider>
    </ConsolePlacesProvider>
  );
};
