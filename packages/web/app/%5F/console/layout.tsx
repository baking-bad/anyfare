import '../../console.css';

import type { ReactNode } from 'react';

import { readSettings } from '../../../src/config';
import { ConsoleRoot } from '../../../src/console/ConsoleRoot';
import { consoleOverviewPath } from '../../../src/hosts';

// The console's pages, where the proxy sends the console host's paths. The server renders the frame's shell only:
// the browser holds the master key, reads the account with it, and fills the page.
const ConsoleLayout = ({ children }: { readonly children: ReactNode }) => {
  const settings = readSettings();

  return <ConsoleRoot siteUrl={settings.siteUrl} overviewPath={consoleOverviewPath(settings)}>{children}</ConsoleRoot>;
};

export default ConsoleLayout;
