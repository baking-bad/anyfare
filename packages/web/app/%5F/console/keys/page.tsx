import type { Metadata } from 'next';

import { ConsolePage } from '../../../../src/console/ConsolePage';
import { consoleMetadata } from '../../../../src/console/pages';

export const generateMetadata = (): Metadata => consoleMetadata('keys');

export const dynamic = 'force-dynamic';

const Keys = () => <ConsolePage page="keys" />;

export default Keys;
