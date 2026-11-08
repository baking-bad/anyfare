// The facilitator: node packages/facilitator/dist/main.js
import { runApp } from '@anyfare/common';

import { startFacilitator } from './start.js';

await runApp({ name: 'facilitator', start: startFacilitator });
