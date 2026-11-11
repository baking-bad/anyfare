import type { Metadata } from 'next';

import { ConsolePage } from '../../../../src/console/ConsolePage';
import { consoleMetadata } from '../../../../src/console/pages';

export const generateMetadata = (): Metadata => consoleMetadata('signin');

export const dynamic = 'force-dynamic';

const SignInPage = () => <ConsolePage page="signin" />;

export default SignInPage;
