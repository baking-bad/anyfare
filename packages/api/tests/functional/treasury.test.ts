import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@anyfare/common';
import { loadPlatformConfig } from '@anyfare/core';
import { auditLog, createLedger, createTreasuryRepository, ledgerAccountIds } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const clock = createFakeClock(fixtureTime(0, 9, 10, 0, 0, 0));

let database: TestDatabase;
let redis: TestRedis;
let server: ApiServer;
let internalUrl: string;

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, internalSecret: Secret.from(internalSecret) });
  const { internalPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
  internalUrl = `http://127.0.0.1:${internalPort!}`;
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const post = async (body: unknown, headers: Record<string, string> = { 'x-internal-secret': internalSecret, 'x-internal-caller': 'operator' }) => {
  const response = await fetch(`${internalUrl}/internal/v1/treasury/transfers`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const actions = async (subjectId: string) => (await database.db.select().from(auditLog).where(eq(auditLog.subjectId, subjectId))).map(entry => entry.action);

describe('POST /internal/v1/treasury/transfers', () => {
  const transfer = {
    reference: 'swap-1',
    from: { asset: 'base-usdc', amount: '100' },
    to: { asset: 'solana-usdc', amount: '99.5' },
    transactions: ['0xabc', 'f00d'],
  };

  it('books a rebalancing once and records it: the source treasury holds less, the target more, the difference is conversion cost', async () => {
    const created = await post(transfer);
    const replayed = await post(transfer);
    const balances = await createLedger({ db: database.db, clock, ids: randomIdGenerator })
      .balancesOf([ledgerAccountIds.treasury('base-usdc'), ledgerAccountIds.treasury('solana-usdc'), ledgerAccountIds.conversion]);
    const stored = await createTreasuryRepository({ db: database.db }).findTransfer('swap-1');

    expect(created).toMatchObject({ status: 201, body: { reference: 'swap-1', conversionCost: '0.5', replayed: false, createdAt: clock.now().toISOString() } });
    expect(replayed).toMatchObject({ status: 200, body: { replayed: true, transactionId: created.body['transactionId'] } });
    expect(Object.fromEntries(balances)).toEqual({
      'platform:treasury:base-usdc': 100_000_000n, 'platform:treasury:solana-usdc': -99_500_000n, 'platform:conversion': -500_000n,
    });
    expect(stored).toMatchObject({
      fromAsset: 'base-usdc', fromAmount: 100_000_000n, toAsset: 'solana-usdc', toAmount: 99_500_000n, transactions: ['0xabc', 'f00d'],
      recordedBy: 'operator', ledgerTransactionId: created.body['transactionId'],
    });
    expect(await actions('swap-1')).toEqual(['treasury.transfer', 'treasury.transfer']);
  });

  it('refuses a reused reference for another transfer, and writes nothing for it', async () => {
    const conflict = await post({ ...transfer, to: { asset: 'solana-usdc', amount: '99' } });

    expect(conflict).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect(await actions('swap-1')).toHaveLength(2);
  });

  it('refuses a gain, one asset, zero amounts, and an asset outside the registry', async () => {
    const refused = async (reference: string, change: Record<string, unknown>) => {
      expect((await post({ ...transfer, reference, ...change })).status, reference).toBe(400);
      expect(await actions(reference), reference).toEqual([]);
    };

    await refused('gain', { to: { asset: 'solana-usdc', amount: '101' } });
    await refused('same', { to: { asset: 'base-usdc', amount: '99' } });
    await refused('zero-to', { to: { asset: 'solana-usdc', amount: '0' } });
    await refused('zero-from', { from: { asset: 'base-usdc', amount: '0' }, to: { asset: 'solana-usdc', amount: '0' } });
    await refused('unknown-to', { to: { asset: 'doge', amount: '99' } });
    await refused('unknown-from', { from: { asset: 'doge', amount: '100' } });
    await refused('no-transactions', { transactions: [] });
  });

  it('needs the shared secret', async () => {
    expect((await post({ ...transfer, reference: 'swap-2' }, {})).status).toBe(401);
    expect((await post({ ...transfer, reference: 'swap-2' }, { 'x-internal-secret': 'wrong' })).status).toBe(401);
    expect(await createTreasuryRepository({ db: database.db }).findTransfer('swap-2')).toBeUndefined();
  });
});
