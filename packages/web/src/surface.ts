import { headers } from 'next/headers';

import { surfaceFromHeader, surfaceHeader, type Surface } from './hosts';

// The host this request is for, as proxy.ts decided it.
export const requestSurface = async (): Promise<Surface> => surfaceFromHeader((await headers()).get(surfaceHeader));
