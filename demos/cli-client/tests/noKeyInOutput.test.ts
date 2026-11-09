import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare } from './fakeAnyfare.ts';
import { captureIo, tempAppDir } from './helpers.ts';

let fake: FakeAnyfare;
beforeAll(async () => {
  fake = await startFakeAnyfare();
});
afterAll(async () => {
  await fake.close();
});

/** The variables of .env.local, as `npm run demo` would load them. */
function loadEnvLocal(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(dir, '.env.local'), 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) env[match[1]] = match[2];
  }
  return env;
}

describe('the keys', () => {
  it('never appear whole in any output of sign-up, key create, balance and paid calls', async () => {
    const app = tempAppDir();
    const outputs: string[] = [];
    const { fetch } = forwardingFetch(toolRoutes());
    const run = async (argv: readonly string[], extra: Record<string, string> = {}): Promise<number> => {
      const env = {
        ANYFARE_API_URL: fake.apiUrl,
        ANYFARE_PAY_URL: fake.payUrl,
        ...(argv[0] === 'signup' ? {} : loadEnvLocal(app.dir)),
        ...extra,
      };
      const io = captureIo(fetch, env, { appDir: app.dir });
      const code = await runCli(argv, io.io);
      outputs.push(io.out(), io.err());
      return code;
    };
    try {
      for (const target of Object.values(toolTargets())) fake.addTarget(target);
      expect(await run(['signup', '--yes'])).toBe(0);
      expect(await run(['signup', '--yes'])).toBe(1);
      expect(await run(['key', 'create', '--yes'])).toBe(0);
      const keys = loadEnvLocal(app.dir);
      const master = keys['ANYFARE_MASTER_KEY'] ?? '';
      const payment = keys['ANYFARE_PAYMENT_KEY'] ?? '';
      expect(master).toMatch(/^afm_live_[0-9A-Za-z]{43}$/);
      expect(payment).toMatch(/^af_live_[0-9A-Za-z]{43}$/);

      // No Credits yet: refused
      expect(await run(['call', '--tool', 'cmc', '--pay', 'credits', '--yes'])).toBe(1);
      const account = fake.account(master);
      if (account === undefined) throw new Error('Expected the account');
      // A made-up top-up
      account.available = 1_000_000n;
      expect(await run(['balance'])).toBe(0);
      for (const tool of ['cmc', '3route', 'evidence']) {
        expect(await run(['call', '--tool', tool, '--pay', 'credits', '--explain', '--yes'])).toBe(0);
      }
      expect(await run(['key', 'create', '--yes'])).toBe(0);
      expect(await run(['call', '--tool', 'cmc', '--pay', 'credits', '--yes'], { ANYFARE_PAYMENT_KEY: master })).toBe(1);
      expect(await run(['balance'], { ANYFARE_MASTER_KEY: payment })).toBe(1);

      const newPayment = loadEnvLocal(app.dir)['ANYFARE_PAYMENT_KEY'] ?? '';
      const all = outputs.join('\n');
      expect(all).toContain(`${master.slice(0, 10)}…`);
      for (const key of [master, payment, newPayment]) {
        expect(all).not.toContain(key);
        expect(all).not.toContain(key.slice(10));
      }
      expect(all).not.toMatch(/afm?_live_[0-9A-Za-z]{11,}/);
    } finally {
      app.remove();
    }
  });
});
