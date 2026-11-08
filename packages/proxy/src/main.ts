// The proxy: node packages/proxy/dist/main.js
import { runApp } from '@anyfare/common';

import { startProxy } from './start.js';

await runApp({ name: 'proxy', start: startProxy });
