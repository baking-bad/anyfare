import type { Metadata } from 'next';

import { ConsolePage } from '../../../../src/console/ConsolePage';
import { consoleMetadata } from '../../../../src/console/pages';

export const generateMetadata = (): Metadata => consoleMetadata('settings');

export const dynamic = 'force-dynamic';

const Settings = () => <ConsolePage page="settings" />;

export default Settings;
