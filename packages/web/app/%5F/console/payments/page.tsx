import type { Metadata } from 'next';

import { ConsolePage } from '../../../../src/console/ConsolePage';
import { consoleMetadata } from '../../../../src/console/pages';

export const generateMetadata = (): Metadata => consoleMetadata('payments');

export const dynamic = 'force-dynamic';

const Payments = () => <ConsolePage page="payments" />;

export default Payments;
