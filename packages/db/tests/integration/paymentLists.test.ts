import { setTimeout as sleep } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { hashApiKey, InvalidPaymentCursorError, paymentStatuses, type PaymentStatus, type RailName } from '@anyfare/core';
import { createFakeClock, createTestDatabase, createTestPool, type TestDatabase } from '@anyfare/testing';

import {
  createAccountRepository, createPaymentKeyRepository, createPaymentRepository, paymentStateOf, payments, type PaymentFilter, type PaymentRepository,
} from '../../src/index.js';
import * as schema from '../../src/schema/index.js';

// A buyer's list of payments: newest first, a page at a time, narrowed by state, key and host, never another
// account's. And its plan on an account of some size: the buyer index, the filters checked on the rows it walks.

let database: TestDatabase;
let repository: PaymentRepository;
const start = Date.parse('2026-11-12T10:00:00.000Z');

interface Row {
  readonly id: string;
  readonly second: number;
  readonly rail: RailName;
  readonly keyId: string | null;
  readonly host: string;
  readonly status: PaymentStatus;
  readonly buyer?: string | null;
}

const newAccount = async (id: string, keyIds: readonly string[]): Promise<void> => {
  const { db } = database;
  await createAccountRepository({ db }).create({ id, createdAt: new Date(start) });
  for (const keyId of keyIds) {
    await createPaymentKeyRepository({ db }).insert({
      id: keyId, accountId: id, keyHash: hashApiKey(Secret.from(`af_test_${keyId}`)), label: undefined, createdAt: new Date(start),
      allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
    });
  }
};

const insert = async (buyer: string, rows: readonly Row[]): Promise<void> => {
  await database.db.insert(payments).values(rows.map(row => {
    const createdAt = new Date(start + row.second * 1_000);
    const onChain = row.rail !== 'credits';

    return {
      id: row.id,
      requestId: `req-${row.id}`,
      rail: row.rail,
      buyerAccountId: row.buyer === undefined ? buyer : row.buyer,
      keyId: row.keyId,
      targetHost: row.host,
      targetPath: '/v1/data',
      network: onChain ? (row.rail === 'mpp' ? 'eip155:42431' : 'eip155:84532') : null,
      asset: onChain ? 'base-usdc' : null,
      amount: 10_000n,
      status: row.status,
      upstreamStatus: ['held', 'verified'].includes(row.status) ? null : 200,
      needsReview: false,
      createdAt,
      updatedAt: createdAt,
    };
  }));
};

// Account A's payments: three at second 3 and two at second 6, so pages break inside a millisecond's ties
const ownRows: readonly Row[] = [
  { id: 'pay_a01', second: 0, rail: 'credits', keyId: 'key_a1', host: 'api.one.test', status: 'captured' },
  { id: 'pay_a02', second: 1, rail: 'credits', keyId: 'key_a2', host: 'api.two.test', status: 'released' },
  { id: 'pay_a03', second: 2, rail: 'credits', keyId: 'key_a1', host: 'api.two.test', status: 'held' },
  { id: 'pay_a04', second: 3, rail: 'x402', keyId: null, host: 'api.one.test', status: 'settled' },
  { id: 'pay_a05', second: 3, rail: 'x402', keyId: null, host: 'api.one.test', status: 'failed' },
  { id: 'pay_a06', second: 3, rail: 'x402', keyId: null, host: 'api.two.test', status: 'verified' },
  { id: 'pay_a07', second: 4, rail: 'credits', keyId: 'key_a1', host: 'api.one.test:8443', status: 'captured' },
  { id: 'pay_a08', second: 5, rail: 'x402', keyId: null, host: 'api.two.test', status: 'settling' },
  { id: 'pay_a09', second: 6, rail: 'mpp', keyId: null, host: 'api.one.test', status: 'cancelled' },
  { id: 'pay_a10', second: 6, rail: 'credits', keyId: 'key_a2', host: 'api.one.test', status: 'captured' },
];
// Account B's, at the same times, on the same hosts, with IDs that sort among A's; and a chain payment no account owns
const otherRows: readonly Row[] = [
  { id: 'pay_a035', second: 3, rail: 'credits', keyId: 'key_b1', host: 'api.one.test', status: 'captured' },
  { id: 'pay_a095', second: 6, rail: 'credits', keyId: 'key_b1', host: 'api.two.test', status: 'held' },
  { id: 'pay_b01', second: 1, rail: 'credits', keyId: 'key_b1', host: 'api.one.test', status: 'released' },
  { id: 'pay_b02', second: 4, rail: 'x402', keyId: null, host: 'api.one.test', status: 'settled' },
  { id: 'pay_n01', second: 5, rail: 'x402', keyId: null, host: 'api.one.test', status: 'settled', buyer: null },
];

// Newest first, then by ID
const newestFirst = ['pay_a10', 'pay_a09', 'pay_a08', 'pay_a07', 'pay_a06', 'pay_a05', 'pay_a04', 'pay_a03', 'pay_a02', 'pay_a01'];

beforeAll(async () => {
  database = await createTestDatabase();
  repository = createPaymentRepository({ db: database.db, clock: createFakeClock('2026-11-12T10:00:00.000Z') });
  await newAccount('acc_lists_a', ['key_a1', 'key_a2']);
  await newAccount('acc_lists_b', ['key_b1']);
  await insert('acc_lists_a', ownRows);
  await insert('acc_lists_b', otherRows);
});

afterAll(async () => {
  await database?.drop();
});

const idsOf = async (filter: PaymentFilter, buyerAccountId = 'acc_lists_a'): Promise<string[]> =>
  (await repository.listForBuyer({ buyerAccountId, limit: 100, filter })).payments.map(payment => payment.id);

/** Every page of a list, by the cursor each gives. */
const allPages = async (input: { readonly limit: number; readonly filter?: PaymentFilter }): Promise<string[][]> => {
  const pages: string[][] = [];
  let after: string | undefined;
  do {
    const page = await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', ...input, ...after === undefined ? {} : { after } });
    pages.push(page.payments.map(payment => payment.id));
    after = page.next;
  } while (after !== undefined && pages.length < 20);

  return pages;
};

describe('a buyer\'s list of payments', () => {
  it('holds the buyer\'s own payments newest first, then by ID, and no other account\'s', async () => {
    expect(await idsOf({})).toEqual(newestFirst);
    expect(await idsOf({}, 'acc_lists_b')).toEqual(['pay_a095', 'pay_b02', 'pay_a035', 'pay_b01']);
    expect(await idsOf({}, 'acc_unknown')).toEqual([]);
  });

  it('pages through ties on the creation time, each payment once, with no cursor after the last page', async () => {
    expect(await allPages({ limit: 3 })).toEqual([
      ['pay_a10', 'pay_a09', 'pay_a08'], ['pay_a07', 'pay_a06', 'pay_a05'], ['pay_a04', 'pay_a03', 'pay_a02'], ['pay_a01'],
    ]);
    expect(await allPages({ limit: 1 })).toEqual(newestFirst.map(id => [id]));
    // A page that ends with the last payment has no next
    expect((await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 10 })).next).toBeUndefined();
  });

  it.each([
    ['paid', { state: 'paid' }, ['pay_a10', 'pay_a08', 'pay_a07', 'pay_a04', 'pay_a01']],
    ['free', { state: 'free' }, ['pay_a09', 'pay_a05', 'pay_a02']],
    ['pending', { state: 'pending' }, ['pay_a06', 'pay_a03']],
    ['a key', { keyId: 'key_a1' }, ['pay_a07', 'pay_a03', 'pay_a01']],
    ['the other key', { keyId: 'key_a2' }, ['pay_a10', 'pay_a02']],
    ['another account\'s key', { keyId: 'key_b1' }, []],
    ['an unknown key', { keyId: 'key_nobody' }, []],
    ['a host, exactly: not the same host on another port', { targetHost: 'api.one.test' }, ['pay_a10', 'pay_a09', 'pay_a05', 'pay_a04', 'pay_a01']],
    ['a host with its port', { targetHost: 'api.one.test:8443' }, ['pay_a07']],
    ['a part of a host, which is no host', { targetHost: 'api.one' }, []],
    ['paid with a key', { state: 'paid', keyId: 'key_a1' }, ['pay_a07', 'pay_a01']],
    ['paid on a host', { state: 'paid', targetHost: 'api.one.test' }, ['pay_a10', 'pay_a04', 'pay_a01']],
    ['pending with a key on a host', { state: 'pending', keyId: 'key_a1', targetHost: 'api.two.test' }, ['pay_a03']],
    ['free with a key on a host', { state: 'free', keyId: 'key_a2', targetHost: 'api.two.test' }, ['pay_a02']],
    ['free with a key on another host', { state: 'free', keyId: 'key_a2', targetHost: 'api.one.test' }, []],
  ] as const)('narrows to %s', async (_case, filter, expected) => {
    expect(await idsOf(filter)).toEqual(expected);
  });

  it('pages a filtered list the same way', async () => {
    expect(await allPages({ limit: 2, filter: { state: 'paid' } })).toEqual([['pay_a10', 'pay_a08'], ['pay_a07', 'pay_a04'], ['pay_a01']]);
    expect(await allPages({ limit: 1, filter: { targetHost: 'api.one.test', state: 'free' } })).toEqual([['pay_a09'], ['pay_a05']]);
  });

  it('takes a cursor as where to go on, whatever filters made it, and whoever\'s list gave it', async () => {
    // The first page of all, ending at pay_a08, then the free payments older than it
    const first = await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 3 });
    const free = await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 10, after: first.next!, filter: { state: 'free' } });
    expect(free.payments.map(payment => payment.id)).toEqual(['pay_a05', 'pay_a02']);
    // A page of paid ones, ending at pay_a07, then everything older
    const paid = await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 3, filter: { state: 'paid' } });
    const rest = await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 10, after: paid.next! });
    expect(rest.payments.map(payment => payment.id)).toEqual(newestFirst.slice(newestFirst.indexOf('pay_a07') + 1));
    // Another account's cursor, ending at its pay_a035 inside the tie at second 3: still only the buyer's own, older ones
    const others = await repository.listForBuyer({ buyerAccountId: 'acc_lists_b', limit: 2 });
    expect(others.payments.map(payment => payment.id)).toEqual(['pay_a095', 'pay_b02']);
    const third = await repository.listForBuyer({ buyerAccountId: 'acc_lists_b', limit: 1, after: others.next! });
    expect(third.payments.map(payment => payment.id)).toEqual(['pay_a035']);
    const own = await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 10, after: third.next! });
    expect(own.payments.map(payment => payment.id)).toEqual(['pay_a03', 'pay_a02', 'pay_a01']);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['no time', Buffer.from('|pay_a01').toString('base64url')],
    ['no ID', Buffer.from('2026-11-12T10:00:03.000Z|').toString('base64url')],
    ['an ID with a NUL', Buffer.from('2026-11-12T10:00:03.000Z|pay_\u0000a').toString('base64url')],
    ['an ID with a space', Buffer.from('2026-11-12T10:00:03.000Z|pay a').toString('base64url')],
    ['a third part', Buffer.from('2026-11-12T10:00:03.000Z|pay_a04|x').toString('base64url')],
    ['a year the database can\'t take', Buffer.from('+010000-01-01T00:00:00.000Z|pay_a04').toString('base64url')],
  ])('refuses a cursor with %s', async (_case, after) => {
    await expect(repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 10, after })).rejects.toBeInstanceOf(InvalidPaymentCursorError);
  });

  it('gives the state of every status: the public calls\' paid and free, and the rest pending', () => {
    expect(Object.fromEntries(paymentStatuses.map(status => [status, paymentStateOf(status)]))).toEqual({
      held: 'pending', verified: 'pending', captured: 'paid', settling: 'paid', settled: 'paid', released: 'free', cancelled: 'free', failed: 'free',
    });
  });

  it('reads with a statement timeout when asked: the same rows, and a read that can\'t finish gives up', async () => {
    expect((await repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 100, timeoutMs: 1_000 })).payments.map(payment => payment.id)).toEqual(newestFirst);

    let failure: unknown;
    await database.db.transaction(async tx => {
      await tx.execute(sql`lock table payments in access exclusive mode`);
      const started = Date.now();
      const read = repository.listForBuyer({ buyerAccountId: 'acc_lists_a', limit: 10, filter: { state: 'free' }, timeoutMs: 200 });
      failure = await Promise.race([read.then(() => 'answered', (error: unknown) => error), sleep(3_000).then(() => 'still waiting')]);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('57014');
    // The connection went back without the timeout: a read without one isn't cut short
    expect(await database.db.execute(sql`show statement_timeout`)).toMatchObject({ rows: [{ statement_timeout: '0' }] });
  });
});

describe('the plan of a buyer\'s list on an account of some size', () => {
  // 10,000 payments of one account, ten on a rare key and five on a rare host, among 50,000 of five others
  const accountSize = 10_000;
  const sideAccounts = ['acc_side_1', 'acc_side_2', 'acc_side_3', 'acc_side_4', 'acc_side_5'];
  let pool: pg.Pool;
  const queries: { sql: string; params: unknown[] }[] = [];

  beforeAll(async () => {
    await newAccount('acc_big', ['key_big', 'key_rare']);
    for (const side of sideAccounts)
      await newAccount(side, [`key_${side}`]);
    const rows = (buyer: string, keyOf: (index: number) => string) => Array.from({ length: accountSize }, (_, index) => {
      const createdAt = new Date(start + 3_600_000 + index * 1_000);

      return {
        id: `pay_${buyer}_${String(index).padStart(6, '0')}`, rail: 'credits' as const, buyerAccountId: buyer, keyId: keyOf(index),
        targetHost: index % 2_000 === 7 ? 'rare.example.com' : `api-${index % 40}.example.com`, targetPath: '/v1/data', amount: 1_100n,
        status: (index % 20 === 0 ? 'held' : index % 7 === 0 ? 'released' : 'captured') as PaymentStatus, upstreamStatus: 200, needsReview: false, createdAt,
        updatedAt: createdAt,
      };
    });
    const all = [
      ...rows('acc_big', index => index % 1_000 === 3 ? 'key_rare' : 'key_big'),
      ...sideAccounts.flatMap(side => rows(side, () => `key_${side}`)),
    ];
    for (let index = 0; index < all.length; index += 2_000)
      await database.db.insert(payments).values(all.slice(index, index + 2_000));
    pool = createTestPool(database);
    await pool.query('analyze payments');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  // The plan of the list's select, as the repository sends it
  const planOf = async (filter: PaymentFilter, after?: string): Promise<string> => {
    queries.length = 0;
    const recording = createPaymentRepository({
      db: drizzle({ client: pool, schema, logger: { logQuery: (query, params) => queries.push({ sql: query, params }) } }),
      clock: createFakeClock('2026-11-12T10:00:00.000Z'),
    });
    await recording.listForBuyer({ buyerAccountId: 'acc_big', limit: 50, filter, ...after === undefined ? {} : { after } });
    const select = queries.find(query => query.sql.startsWith('select'))!;
    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`explain (costs off) ${select.sql}`, select.params);

    return rows.map(row => row['QUERY PLAN']).join('\n');
  };

  // Newest first along the index; or, when the planner finds few rows match, the account's rows by the index, the
  // filters on each, and the few that match sorted. Either way no other index, and no table read whole.
  const expectBuyerIndex = (plan: string, name: string): void => {
    expect(plan, `${name}\n${plan}`).toMatch(/Index Scan Backward using payments_buyer_idx on payments|Bitmap Index Scan on payments_buyer_idx\b/);
    expect(plan.match(/using \w+|Scan on \w+_idx/g)?.filter(index => !index.endsWith('payments_buyer_idx')), `${name}\n${plan}`).toEqual([]);
    expect(plan, `${name}\n${plan}`).not.toMatch(/Seq Scan/);
  };

  it('walks the buyer index alone, newest first, with the filters on its rows', async () => {
    const first = await repository.listForBuyer({ buyerAccountId: 'acc_big', limit: 50 });
    for (const [name, filter] of [
      ['none', {}],
      ['a rare key', { keyId: 'key_rare' }],
      ['a rare host', { targetHost: 'rare.example.com' }],
      ['free', { state: 'free' }],
      ['pending', { state: 'pending' }],
      ['a rare key on a rare host', { keyId: 'key_rare', targetHost: 'rare.example.com', state: 'paid' }],
    ] as const) {
      for (const after of [undefined, first.next]) {
        expectBuyerIndex(await planOf(filter, after), name);
      }
    }
    // With no filter the page is the index's first rows: nothing is sorted
    expect(await planOf({})).not.toMatch(/Sort/);
  });

  it('starts a later page at the cursor, as a bound of the index', async () => {
    const first = await repository.listForBuyer({ buyerAccountId: 'acc_big', limit: 50 });
    const plan = await planOf({ keyId: 'key_rare' }, first.next);

    expect(plan, plan).toMatch(/Index Cond: \(\(buyer_account_id = .*created_at <= .*ROW\(created_at, id\) < ROW/s);
  });
});
