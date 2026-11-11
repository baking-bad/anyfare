import type { Metadata } from 'next';

import { ConsolePage } from '../../../src/console/ConsolePage';
import { consoleMetadata } from '../../../src/console/pages';

export const generateMetadata = (): Metadata => consoleMetadata('overview');

export const dynamic = 'force-dynamic';

const Overview = () => <ConsolePage page="overview" />;

export default Overview;
