import { fullGuide } from '../../src/agents/full';
import { textResponse } from '../../src/agents/links';
import { readSettings } from '../../src/config';

export const dynamic = 'force-dynamic';

/** Every endpoint, request and answer, the 402, the errors and the limits, in one file. */
export const GET = (): Response => textResponse(fullGuide(readSettings()), 'text/plain');
