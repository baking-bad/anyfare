import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { hashApiKey, type PaymentStatus } from '@anyfare/core';
import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { createCallRepository } from '../../src/callRepository.js';
import { createAccountRepository, createPaymentKeyRepository } from '../../src/index.js';
import * as schema from '../../src/schema/index.js';

// The plans of the public reads of calls on a database of some size: each read reaches payments by
// an index, never by a scan of the table.

let database: TestDatabase;
let pool: pg.Pool;
const queries: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
const start = Date.parse('2026-11-12T00:00:00.000Z');
const callCount = 20_000;
const statuses: readonly PaymentStatus[] = ['settled', 'settled', 'failed', 'cancelled', 'settling'];

beforeAll(async () => {
  database = await createTestDatabase();
  const { db } = database;
  await createAccountRepository({ db }).create({ id: 'acc_plans', createdAt: new Date(start) });
  await createPaymentKeyRepository({ db }).insert({
    id: 'key_plans', accountId: 'acc_plans', keyHash: hashApiKey(Secret.from('af_test_plans')), label: undefined, createdAt: new Date(start),
    allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  // A third Credits, the rest x402 on Base or NEAR and MPP on Tempo; one in twenty still in flight
  const rows = Array.from({ length: callCount }, (_, index) => {
    const createdAt = new Date(start + index * 1_000);
    const kind = index % 6;
    const inFlight = index % 20 === 0;
    const credits = kind < 2;
    const rail = credits ? 'credits' as const : kind === 5 ? 'mpp' as const : 'x402' as const;
    const status: PaymentStatus = credits ? (inFlight ? 'held' : index % 7 === 0 ? 'released' : 'captured') : inFlight ? 'verified' : statuses[index % statuses.length]!;

    return {
      id: `pay_${String(index).padStart(6, '0')}`,
      rail,
      buyerAccountId: credits ? 'acc_plans' : null,
      keyId: credits ? 'key_plans' : null,
      targetHost: `api-${index % 40}.example.com`,
      targetPath: `/v1/endpoint/${index % 300}`,
      network: credits ? null : rail === 'mpp' ? 'eip155:42431' : kind === 2 ? 'near:testnet' : 'eip155:84532',
      asset: credits ? null : 'base-usdc',
      amount: 1_100n,
      status,
      upstreamStatus: 200,
      upstreamLatencyMs: 100,
      needsReview: false,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 700),
    };
  });
  for (let index = 0; index < rows.length; index += 1_000) {
    const batch = rows.slice(index, index + 1_000);
    await db.insert(schema.payments).values(batch);
    await db.insert(schema.targetPayments).values(batch.map(row => ({
      paymentId: row.id, protocol: 'x402' as const, network: 'eip155:84532', asset: 'base-usdc', amount: 1_000n, atomicAmount: 1_000n,
      payTo: '0x4444444444444444444444444444444444444444', signatureId: `sig-${row.id}`, status: 'settled' as const, createdAt: row.createdAt, updatedAt: row.updatedAt,
    })));
    await db.insert(schema.callDetails).values(batch.map(row => ({ paymentId: row.id, method: 'GET', payer: null, arrivedAt: row.createdAt })));
  }
  pool = new pg.Pool({ connectionString: database.url.expose() });
  await pool.query('analyze');
// Seeding 20,000 calls takes longer than the default hook limit on a busy machine
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

// The repository on a connection that records every query it sends
const recording = () => {
  queries.length = 0;

  return createCallRepository({
    db: drizzle({ client: pool, schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }),
  });
};

const plan = async (query: { readonly sql: string; readonly params: readonly unknown[] }): Promise<string> => {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`explain (costs off) ${query.sql}`, [...query.params]);

  return rows.map(row => row['QUERY PLAN']).join('\n');
};

/** The plans of the queries one list sends: the count, the page's IDs, and the page's rows. */
const listPlans = async (filter: Parameters<ReturnType<typeof createCallRepository>['list']>[0]['filter']): Promise<readonly string[]> => {
  const found = await recording().list({ filter, offset: 20, limit: 20, cap: 10_000 });
  expect(found.calls.length).toBeGreaterThan(0);

  return Promise.all(queries.map(plan));
};

// Read in the index's order, or, when the planner finds few rows match, all of those by the index
const expectIndexed = (plans: readonly string[], index: string): void => {
  const [count, page, rows] = plans;
  for (const each of [count!, page!])
    expect(each, each).toMatch(new RegExp(`Scan(?: Backward)? using ${index} on payments|Bitmap Index Scan on ${index}\\b`));
  expect(rows, rows).toContain('payments_pkey');
  // Nor any table read whole: payments, the API legs, or the details
  for (const each of plans)
    expect(each, each).not.toMatch(/Seq Scan/);
};

describe('the plans of the public reads of calls', () => {
  it('reads every finished call newest first by the calls index', async () => {
    expectIndexed(await listPlans({}), 'payments_calls_idx');
  });

  it('reads by how the buyer paid with the paid-with index: Credits, and a network', async () => {
    expectIndexed(await listPlans({ paidWith: { rail: 'credits' } }), 'payments_calls_paid_with_idx');
    expectIndexed(await listPlans({ paidWith: { rail: 'x402', network: 'near:testnet' } }), 'payments_calls_paid_with_idx');
  });

  it('reads by the exact path with the path index, by its md5, and how the buyer paid on the same rows', async () => {
    const plans = await listPlans({ path: '/v1/endpoint/7' });
    expectIndexed(plans, 'payments_calls_path_idx');
    expect(plans[1], plans[1]).toContain('md5(target_path) = \'');
    expectIndexed(await listPlans({ path: '/v1/endpoint/7', paidWith: { rail: 'credits' } }), 'payments_calls_path_idx');
  });

  it('reads by the exact host with the host index, by its md5, and a host with a path by the path index', async () => {
    const plans = await listPlans({ host: 'api-3.example.com' });
    expectIndexed(plans, 'payments_calls_host_idx');
    expect(plans[1], plans[1]).toContain('md5(target_host) = \'');
    expectIndexed(await listPlans({ host: 'api-3.example.com', paidWith: { rail: 'credits' }, outcome: 'paid' }), 'payments_calls_host_idx');
    expectIndexed(await listPlans({ host: 'api-7.example.com', path: '/v1/endpoint/7' }), 'payments_calls_path_idx');
  });

  it('filters by a part of the host and the outcome on the newest calls of the index path', async () => {
    expectIndexed(await listPlans({ hostContains: 'api-3.' }), 'payments_calls_idx');
    expectIndexed(await listPlans({ outcome: 'free' }), 'payments_calls_idx');
    expectIndexed(await listPlans({ paidWith: { rail: 'mpp', network: 'eip155:42431' }, outcome: 'paid', hostContains: 'api-5' }), 'payments_calls_paid_with_idx');
  });

  it('finds one call by its key, and reads calls as they become final by the final index', async () => {
    const calls = recording();
    expect(await calls.find('pay_000003')).toBeDefined();
    const [found] = await Promise.all(queries.map(plan));
    expect(found, found).toContain('payments_pkey');

    const stream = recording();
    expect(await stream.finalizedAfter({ after: { updatedAt: new Date(start + (callCount - 100) * 1_000), id: '' }, limit: 200 })).not.toHaveLength(0);
    const [read] = await Promise.all(queries.map(plan));
    expect(read, read).toContain('using payments_calls_final_idx on payments');
    expect(read, read).not.toMatch(/Seq Scan/);
  });
});
