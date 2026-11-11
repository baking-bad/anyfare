import type { MetadataRoute } from 'next';

import { readSettings } from '../src/config';
import { consoleRobotsRules, robotsRules } from '../src/seo/robots';
import { requestSurface } from '../src/surface';

export const dynamic = 'force-dynamic';

const robots = async (): Promise<MetadataRoute.Robots> => await requestSurface() === 'console' ? consoleRobotsRules() : robotsRules(readSettings());

export default robots;
