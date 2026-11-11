import { platformGuide } from '../../src/agents/guide';
import { textResponse } from '../../src/agents/links';
import { readSettings } from '../../src/config';

export const dynamic = 'force-dynamic';

/** The short guide an agent reads first. */
export const GET = (): Response => textResponse(platformGuide(readSettings()), 'text/plain');
