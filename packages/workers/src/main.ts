// Workers: node packages/workers/dist/main.js
import { runApp } from '@anyfare/common';

import { startWorkers } from './start.js';

await runApp({ name: 'workers', start: startWorkers });
