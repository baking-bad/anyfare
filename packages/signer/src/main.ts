// The Signer: node packages/signer/dist/main.js
import { runApp } from '@anyfare/common';

import { startSigner } from './start.js';

await runApp({ name: 'signer', start: startSigner });
