// The Platform API: node packages/api/dist/main.js
import { runApp } from '@anyfare/common';

import { startApi } from './start.js';

await runApp({ name: 'api', start: startApi });
