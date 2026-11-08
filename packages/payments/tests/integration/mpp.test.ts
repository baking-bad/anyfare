import { once } from 'node:events';

import { Challenge, Credential, PaymentRequest, Receipt, Store } from 'mppx';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, Secret, SecretDestroyedError, type Logger } from '@anyfare/common';
import {
  canChangePaymentStatus, InvalidPaymentStatusChangeError, loadPlatformConfig, type JsonObject, type Payment, type PlatformConfig, type SettleInput,
} from '@anyfare/core';
import { createRedis, createRedisReplayStore } from '@anyfare/db';
import {
  createFakeClock, createTestRedis, createTestTempoPayer, pathUsdAddress, pushMppCredential, startFakeTempoRpc, tamperMppSignature,
  type FakeTempoRpc, type TempoTransactionChange, type TestTempoPayer,
} from '@anyfare/testing';

import {
  createMppRail, createMppSettlementCheck, fromMppSettlementRequest, initializeMpp, maxTransactionWindowMs, minTransactionWindowMs,
  mppReceiptGraceMs, PaymentInvalidError, PaymentUnavailableError, SettlementFailedError, TempoChainMismatchError, type Authorization,
  type MppAuthorization, type MppSetup, type PaymentRail, type PaymentRecorder, type Quote, type ReplayStore, type SettlementLedger,
} from '../../src/index.js';

const recipient = '0x2222222222222222222222222222222222222222';
const otherRecipient = '0x3333333333333333333333333333333333333333';
const secretKey = 'mpp-test-secret-key-of-32-bytes!';
const logger = createLogger({ level: 'silent' });
const timeouts = { connectMs: 1_000, settleMs: 1_000 };
const resource = 'https://pay.anyfare.test/api.example.com/v1/price';
const otherResource = 'https://pay.anyfare.test/api.example.com/v1/other';
// A second TIP-20 stablecoin on Moderato, made up for the test
const alphaUsdAddress = '0x20c0000000000000000000000000000000000001';
const nowSeconds = () => Math.floor(Date.now() / 1_000);

let rpc: FakeTempoRpc;
let payer: TestTempoPayer;
let config: PlatformConfig;
let store: ReplayStore;
let setup: MppSetup;

const load = () => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: Buffer.from(JSON.stringify({ timeouts })).toString('base64') },
});

// The example config with the Tempo asset changed, such as its minimum price or the recipient
const withTempo = (base: PlatformConfig, change: { readonly minPrice?: bigint; readonly recipient?: string }): PlatformConfig => ({
  ...base,
  assets: base.assets.map(asset => asset.name === 'tempo-pathusd'
    ? { ...asset, ...(change.minPrice === undefined ? {} : { minPrice: change.minPrice }), ...(change.recipient ? { payTo: change.recipient } : {}) }
    : asset),
  mpp: { ...base.mpp, ...(change.recipient ? { recipient: change.recipient } : {}) },
});

// The example config with a second Tempo asset on mpp.network
const withTwoTempoAssets = (base: PlatformConfig): PlatformConfig => {
  const pathUsd = base.assets.find(asset => asset.name === 'tempo-pathusd')!;

  return { ...base, assets: [...base.assets, { ...pathUsd, name: 'tempo-alphausd', address: alphaUsdAddress }] };
};

// A replay store in memory that can go down, as Redis does
const createFlakyStore = () => {
  const memory = Store.memory();
  let down = false;
  const up = () => {
    if (down)
      throw new Error('The replay store is down');
  };
  const replay: ReplayStore = {
    get: async key => {
      up();
      return memory.get(key);
    },
    put: async (key, value) => {
      up();
      await memory.put(key, value);
    },
    delete: async key => {
      up();
      await memory.delete(key);
    },
    update: async (key, fn) => {
      up();
      return memory.update(key, fn);
    },
  };

  return {
    replay,
    down: (value: boolean) => {
      down = value;
    },
  };
};

const initialize = (options: { readonly config?: PlatformConfig; readonly key?: string; readonly replay?: ReplayStore } = {}) => initializeMpp({
  config: options.config ?? config,
  secretKey: Secret.from(options.key ?? secretKey),
  store: options.replay ?? store,
  timeoutMs: 2_000,
  rpcUrl: rpc.url,
});

beforeAll(async () => {
  rpc = await startFakeTempoRpc({ timeoutMs: 2_000 });
  payer = createTestTempoPayer({ rpcUrl: rpc.url });
  config = await load();
});

afterAll(async () => {
  await rpc?.close();
});

beforeEach(async () => {
  rpc.reset();
  store = Store.memory();
  setup = await initialize();
});

interface PortsOptions {
  readonly log?: Logger;
  // The ledger's settle throws it
  readonly bookingFails?: Error;
  // The recorder's create throws it
  readonly createFails?: Error;
  // Changes to these statuses throw
  readonly failingChanges?: readonly Payment['status'][];
}

// In-memory ports: the payment rows, with the status changes the payment status graph allows, and
// what the ledger books
const createPorts = (railSetup: MppSetup = setup, { log = logger, bookingFails, createFails, failingChanges = [] }: PortsOptions = {}) => {
  const rows = new Map<string, Payment>();
  const created: Parameters<PaymentRecorder['create']>[0][] = [];
  const changes: Parameters<PaymentRecorder['changeStatus']>[0][] = [];
  const settled: SettleInput[] = [];
  const update = (paymentId: string, to: Payment['status'], fields: Partial<Payment> = {}, from?: Payment['status']): Payment => {
    const row = rows.get(paymentId);
    if (!row || !canChangePaymentStatus(row.status, to) || (from !== undefined && row.status !== from))
      throw new InvalidPaymentStatusChangeError(paymentId, row?.status, to);
    const next = { ...row, ...fields, status: to };
    rows.set(paymentId, next);

    return next;
  };
  const recorder: PaymentRecorder = {
    create: async payment => {
      if (createFails)
        throw createFails;
      if (rows.has(payment.id))
        throw new Error(`The payment ${payment.id} exists`);
      created.push(payment);
      const at = new Date();
      const row: Payment = {
        ...payment, fee: undefined, decision: undefined, upstreamStatus: undefined, upstreamLatencyMs: undefined, transactionHash: payment.transactionHash,
        receipt: undefined, needsReview: false, createdAt: at, updatedAt: at,
      };
      rows.set(payment.id, row);

      return row;
    },
    recordDecision: async () => {
      throw new Error('The rail records no decision');
    },
    changeStatus: async change => {
      if (failingChanges.includes(change.to))
        throw new Error(`The database is down, so the payment can't become ${change.to}`);
      const next = update(change.paymentId, change.to, {
        ...change.transactionHash === undefined ? {} : { transactionHash: change.transactionHash },
        ...change.receipt === undefined ? {} : { receipt: change.receipt },
        ...change.needsReview === undefined ? {} : { needsReview: change.needsReview },
      }, change.from);
      changes.push(change);

      return next;
    },
    find: async paymentId => rows.get(paymentId),
  };
  const ledger: SettlementLedger = {
    settle: async input => {
      if (bookingFails)
        throw bookingFails;
      settled.push(input);

      return { payment: update(input.paymentId, 'settled', { transactionHash: input.transactionHash, receipt: input.receipt }), fee: 0n };
    },
  };

  return {
    created, changes, settled, rows,
    rail: createMppRail({ setup: railSetup, recorder, ledger, logger: log, clock: { now: () => new Date() }, settleTimeoutMs: timeouts.settleMs }),
  };
};

let counter = 0;
const quoteOf = (price = 1_000n, url = resource): Quote => {
  counter += 1;

  return {
    paymentId: `pay_mpp_${counter}`,
    requestId: `req-${counter}`,
    resource: url,
    priceMicroUsd: price,
    description: 'GET api.example.com/v1/price',
    subject: { targetHost: 'api.example.com', targetPath: '/v1/price' },
  };
};

// The 402 as a client sees it, from the rail's part of it
const challengeResponse = async (rail: PaymentRail, quote: Quote): Promise<Response> =>
  new Response(null, { status: 402, headers: (await rail.challenge(quote))!.headers });

const credentialOf = (rail: PaymentRail, header: string) => rail.detect({ authorization: header })!;

/** A credential `mppx`'s client signs for the rail's 402 for `quote`. */
const pay = async (rail: PaymentRail, quote: Quote): Promise<string> => payer.credentialFor(await challengeResponse(rail, quote));

/** A verified MPP payment, ready to finalize or abort, with its transaction changed when told. */
const authorized = async ({ railSetup = setup, change, ...options }: PortsOptions & { readonly railSetup?: MppSetup; readonly change?: TempoTransactionChange } = {}) => {
  const ports = createPorts(railSetup, options);
  const quote = quoteOf();
  const header = await pay(ports.rail, quote);
  const authorization = await ports.rail.authorize(credentialOf(ports.rail, change ? await payer.resign(header, change) : header), quote);

  return { ...ports, quote, authorization };
};

// The change finalize records before the broadcast: settling, with the hash and the settlement request
const beforeBroadcast = (paymentId: string, hash: string | undefined) => ({
  paymentId, to: 'settling', from: 'verified', transactionHash: hash, settlementRequest: expect.objectContaining({ rail: 'mpp', transactionHash: hash }),
});

/** The rail's 402 with only the challenge for one currency, as a client that pays in it picks it. */
const challengeIn = async (rail: PaymentRail, quote: Quote, currency: string): Promise<Response> => {
  const challenges = Challenge.deserializeList((await rail.challenge(quote))!.headers!['www-authenticate']!)
    .filter(challenge => challenge.request['currency'] === currency);

  return new Response(null, { status: 402, headers: { 'www-authenticate': challenges.map(challenge => Challenge.serialize(challenge)).join(', ') } });
};

describe('the MPP challenge', () => {
  it('offers a Tempo charge in pathUSD on Moderato: the price, pull mode only, and the recipient, bound to the canonical pay URL', async () => {
    const { rail } = createPorts();
    const quote = quoteOf(1_234n);

    const part = await rail.challenge(quote);

    expect(part?.body).toBeUndefined();
    const challenges = Challenge.deserializeList(part!.headers!['www-authenticate']!);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({
      method: 'tempo',
      intent: 'charge',
      realm: 'pay.anyfare.test',
      description: 'GET api.example.com/v1/price',
      request: { amount: '1234', currency: pathUsdAddress, recipient, methodDetails: { chainId: 42_431, supportedModes: ['pull'] } },
    });
    // The URL the credential is bound to, in the HMAC-bound opaque field
    expect(PaymentRequest.deserialize(challenges[0]!.opaque!)).toEqual({ _mppx_scope: quote.resource });
    expect(Date.parse(challenges[0]!.expires!)).toBeGreaterThan(Date.now());
    expect(challenges[0]!.request['methodDetails']).not.toHaveProperty('feePayer');
  });

  it('offers each Tempo asset on mpp.network from its own server, and verifies and settles a credential in each', async () => {
    const { rail, created, settled } = createPorts(await initialize({ config: withTwoTempoAssets(config) }));

    const challenges = Challenge.deserializeList((await rail.challenge(quoteOf()))!.headers!['www-authenticate']!);

    expect(challenges.map(challenge => challenge.request['currency'])).toEqual([pathUsdAddress, alphaUsdAddress]);
    for (const currency of [pathUsdAddress, alphaUsdAddress]) {
      const quote = quoteOf();
      const header = await payer.credentialFor(await challengeIn(rail, quote, currency));
      const receipt = await rail.finalize(await rail.authorize(credentialOf(rail, header), quote));

      expect(receipt.settlement?.status).toBe('settled');
    }
    expect(created.map(payment => payment.asset)).toEqual(['tempo-pathusd', 'tempo-alphausd']);
    expect(settled.map(entry => entry.asset)).toEqual(['tempo-pathusd', 'tempo-alphausd']);
    expect(rpc.rawTransactions).toHaveLength(2);
  });

  it('offers no Tempo option below the asset\'s minimum price', async () => {
    const { rail } = createPorts(await initialize({ config: withTempo(config, { minPrice: 10_000n }) }));

    expect(await rail.challenge(quoteOf(9_999n))).toBeUndefined();
    expect(Challenge.deserializeList((await rail.challenge(quoteOf(10_000n)))!.headers!['www-authenticate']!)[0]!.request).toMatchObject({ amount: '10000' });
  });
});

describe('MPP payments', () => {
  it('validates a credential signed by mppx\'s client before forwarding, recording it verified with its transaction hash and moving nothing', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();

    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);

    expect(created).toEqual([expect.objectContaining({
      id: quote.paymentId, rail: 'mpp', status: 'verified', network: 'eip155:42431', asset: 'tempo-pathusd', atomicAmount: 1_000n, amount: 1_000n,
      targetHost: 'api.example.com', targetPath: '/v1/price', transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    })]);
    expect(authorization).toMatchObject({ rail: 'mpp', buyer: `address:eip155:42431:${payer.address.toLowerCase()}`, receipt: undefined, asset: 'tempo-pathusd' });
    // mppx's client signs for 25 seconds: the proxy keeps the call under the transaction's validBefore
    expect(authorization.deadlineMs).toBe((authorization as unknown as { settlement: { validBefore: number } }).settlement.validBefore * 1_000);
    expect(authorization.deadlineMs! - Date.now()).toBeGreaterThan(minTransactionWindowMs);
    expect(rpc.rawTransactions).toEqual([]);
    expect(rpc.calls.filter(call => call.method === 'eth_call')).toHaveLength(1);
    expect(JSON.stringify(authorization, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('Payment ');
  });

  it('broadcasts after a billable answer, waits for the receipt, and books it, with Payment-Receipt and private cache control', async () => {
    const { rail, created, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);

    const receipt = await rail.finalize(authorization);

    expect(rpc.rawTransactions).toHaveLength(1);
    const hash = created[0]!.transactionHash;
    expect(rpc.transactions).toContain(hash);
    expect(receipt.headers['cache-control']).toBe('private');
    expect(receipt.settlement).toEqual({ status: 'settled', transaction: hash });
    expect(Receipt.deserialize(receipt.headers['payment-receipt']!)).toMatchObject({ method: 'tempo', status: 'success', reference: hash });
    expect(settled).toEqual([{ paymentId: quote.paymentId, asset: 'tempo-pathusd', transactionHash: hash, receipt: receipt.headers['payment-receipt'], needsReview: false }]);
    expect(rpc.unknownMethods).toEqual([]);
  });

  it('cancels after an answer that isn\'t billable: the transaction is never broadcast', async () => {
    const { rail, changes, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);

    await rail.abort(authorization);

    expect(changes).toEqual([{ paymentId: quote.paymentId, to: 'cancelled' }]);
    expect(rpc.rawTransactions).toEqual([]);
    expect(settled).toEqual([]);
  });

  it('refuses a credential used before, on another replica sharing the replay store, before the upstream is called', async () => {
    const first = createPorts();
    const second = createPorts(await initialize());
    const quote = quoteOf();
    const header = await pay(first.rail, quote);

    await first.rail.authorize(credentialOf(first.rail, header), quote);
    const replayed = second.rail.authorize(credentialOf(second.rail, header), { ...quote, paymentId: 'pay_mpp_replayed' });

    await expect(replayed).rejects.toThrow(PaymentInvalidError);
    await expect(replayed).rejects.toThrow('already used');
    expect(second.created).toEqual([]);
  });

  it('refuses a replay after the broadcast too: nothing is broadcast twice', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    const header = await pay(rail, quote);
    await rail.finalize(await rail.authorize(credentialOf(rail, header), quote));

    await expect(rail.authorize(credentialOf(rail, header), { ...quote, paymentId: 'pay_mpp_again' })).rejects.toThrow(PaymentInvalidError);
    expect(rpc.rawTransactions).toHaveLength(1);
  });

  it.each([
    ['a push credential: a transaction the buyer broadcast itself', async (rail: PaymentRail, quote: Quote) => pushMppCredential(await challengeResponse(rail, quote), payer.address)],
    ['a credential for another amount', async (rail: PaymentRail) => pay(rail, quoteOf(2_000n))],
    ['a credential for another resource', async (rail: PaymentRail) => pay(rail, quoteOf(1_000n, otherResource))],
    ['a credential with a bad signature', async (rail: PaymentRail, quote: Quote) => tamperMppSignature(await pay(rail, quote))],
    ['a credential for another recipient', async (_rail: PaymentRail, quote: Quote) => pay(createPorts(await initialize({ config: withTempo(config, { recipient: otherRecipient }) })).rail, quote)],
    ['a credential from a challenge another server issued', async (_rail: PaymentRail, quote: Quote) => pay(createPorts(await initialize({ key: 'another-secret-key-of-32-bytes!!' })).rail, quote)],
    ['a header that isn\'t an MPP credential', async () => 'Payment not-base64-json'],
  ])('refuses %s with payment_invalid, before the upstream and without a payment row', async (_case, credential) => {
    const { rail, created } = createPorts();
    const quote = quoteOf();

    await expect(rail.authorize(credentialOf(rail, await credential(rail, quote)), quote)).rejects.toThrow(PaymentInvalidError);
    expect(created).toEqual([]);
    expect(rpc.rawTransactions).toEqual([]);
  });

  it('refuses a transaction the node\'s simulation reverts, such as for an insufficient balance', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const header = await pay(rail, quote);
    rpc.simulate('revert');

    await expect(rail.authorize(credentialOf(rail, header), quote)).rejects.toThrow(PaymentInvalidError);
    expect(created).toEqual([]);
  });

  it('answers payment_unavailable while the Tempo RPC doesn\'t answer the check: nothing was paid', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const header = await pay(rail, quote);
    rpc.unavailable(true);

    await expect(rail.authorize(credentialOf(rail, header), quote)).rejects.toThrow(PaymentUnavailableError);
    expect(created).toEqual([]);
  });

  it.each([
    ['reverted', 'revert'],
    ['refused by the node', 'refuse'],
  ] as const)('marks a broadcast %s failed, as its receipt shows, and books nothing', async (_case, outcome) => {
    const { rail, created, changes, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);
    rpc.broadcast(outcome);

    await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'failed' });
    expect(changes).toEqual([beforeBroadcast(quote.paymentId, created[0]!.transactionHash), { paymentId: quote.paymentId, to: 'failed', settlementRequest: null }]);
    expect(settled).toEqual([]);
  });

  it.each([
    ['times out', 'timeout'],
    ['fails at the RPC', 'fail'],
  ] as const)('records a broadcast that %s as settling with its hash, for the follow-up', async (_case, outcome) => {
    const { rail, created, changes, settled } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);
    rpc.broadcast(outcome);

    await expect(rail.finalize(authorization)).rejects.toThrow(SettlementFailedError);
    const hash = created[0]!.transactionHash;
    // Settling from before the broadcast: an unknown outcome needs no other change
    expect(changes).toEqual([beforeBroadcast(quote.paymentId, hash)]);
    expect(fromMppSettlementRequest(changes[0]!.settlementRequest as JsonObject)).toMatchObject({
      currency: pathUsdAddress, recipient, sender: payer.address.toLowerCase(), amount: '1000', validBefore: expect.any(Number),
    });
    expect(settled).toEqual([]);
  });
});

describe('the signed transaction', () => {
  it.each<[string, (now: number) => TempoTransactionChange, string]>([
    ['signed for another chain', () => ({ chainId: 4_217 }), 'wrong_chain'],
    ['valid for 2 seconds', now => ({ validBefore: now + 2 }), 'too_short'],
    ['expired', now => ({ validBefore: now - 1 }), 'too_short'],
    ['not valid yet', now => ({ validAfter: now + 60, validBefore: now + 120 }), 'not_yet_valid'],
    ['valid for longer than the longest window', now => ({ validBefore: now + maxTransactionWindowMs / 1_000 + 60 }), 'too_long'],
  ])('refuses a transaction %s before any RPC call, so the upstream is never called', async (_case, change, reason) => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    const header = await payer.resign(await pay(rail, quote), change(nowSeconds()));
    const before = rpc.calls.length;

    await expect(rail.authorize(credentialOf(rail, header), quote)).rejects.toMatchObject({ code: 'payment_invalid', reason });
    expect(rpc.calls.length).toBe(before);
    expect(created).toEqual([]);
  });

  it('takes a transaction valid for 9 minutes, with its validBefore as the deadline', async () => {
    const validBefore = nowSeconds() + 540;

    const { authorization } = await authorized({ change: { validBefore } });

    expect(authorization.deadlineMs).toBe(validBefore * 1_000);
  });

  it('releases the credential\'s claim when its payment can\'t be recorded, so the same credential may try again', async () => {
    const failing = createPorts(setup, { createFails: new Error('The database is down') });
    const quote = quoteOf();
    const header = await pay(failing.rail, quote);

    await expect(failing.rail.authorize(credentialOf(failing.rail, header), quote)).rejects.toThrow('The database is down');

    const { rail, created } = createPorts();
    await expect(rail.authorize(credentialOf(rail, header), quote)).resolves.toMatchObject({ rail: 'mpp', paymentId: quote.paymentId });
    expect(created).toHaveLength(1);
  });
});

describe('the broadcast', () => {
  it('records the payment as settling with its hash before the broadcast answers', async () => {
    const { rail, created, changes, authorization } = await authorized();
    rpc.broadcast('timeout');

    const finalizing = rail.finalize(authorization).catch((error: unknown) => error);
    await vi.waitFor(() => expect(rpc.rawTransactions).toHaveLength(1));

    expect(changes).toEqual([beforeBroadcast(authorization.paymentId, created[0]!.transactionHash)]);
    expect(await finalizing).toMatchObject({ code: 'settlement_failed', outcome: 'unknown' });
    expect(changes).toHaveLength(1);
  });

  it.each([
    ['has included it', 'already-known'],
    ['holds it pending, with no receipt yet', 'already-known-pending'],
  ] as const)('keeps a transaction the node already knows as settling when it %s, and the follow-up settles it from its receipt', async (_case, outcome) => {
    const { rail, created, changes, settled, authorization } = await authorized();
    const hash = created[0]!.transactionHash;
    rpc.broadcast(outcome);

    await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'unknown', transaction: hash });

    expect(changes).toEqual([beforeBroadcast(authorization.paymentId, hash)]);
    expect(settled).toEqual([]);
    const request = fromMppSettlementRequest(changes[0]!.settlementRequest as JsonObject)!;
    // Within the transaction's validity window: not found yet is pending
    const check = createMppSettlementCheck({ rpc: setup.rpc, timeoutMs: 1_000, clock: createFakeClock(new Date(request.validBefore * 1_000)) });
    if (outcome === 'already-known-pending') {
      expect(await check(request)).toEqual({ status: 'pending' });
      rpc.include(request.transactionHash);
    }
    const status = await check(request);
    expect(status.status === 'settled' && Receipt.deserialize(status.receipt)).toMatchObject({ method: 'tempo', status: 'success', reference: hash });
  });

  it('records a payment whose challenge expired between authorize and finalize as failed: mppx checks it again, and nothing is broadcast', async () => {
    // Valid for 9 minutes, past the challenge's 5
    const { rail, created, changes, authorization } = await authorized({ change: { validBefore: nowSeconds() + 540 } });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);

      await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'failed', reason: expect.stringMatching(/expired/i) });
    }
    finally {
      vi.useRealTimers();
    }

    expect(changes).toEqual([
      beforeBroadcast(authorization.paymentId, created[0]!.transactionHash),
      { paymentId: authorization.paymentId, to: 'failed', settlementRequest: null },
    ]);
    expect(rpc.rawTransactions).toEqual([]);
  });

  it('logs a failed broadcast it can\'t record as failed, and still answers settlement_failed', async () => {
    const lines: string[] = [];
    const captured = createLogger({ level: 'trace' }, { write: (line: string) => lines.push(line) });
    const { rail, rows, authorization } = await authorized({ log: captured, failingChanges: ['failed'] });
    rpc.broadcast('refuse');

    await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'failed' });

    expect(rows.get(authorization.paymentId)?.status).toBe('settling');
    const logged = lines.map(line => JSON.parse(line) as { msg: string; error?: { message: string } });
    expect(logged).toContainEqual(expect.objectContaining({
      msg: 'The failed MPP payment couldn\'t be recorded as failed. The settlement follow-up finds it settling.',
      error: expect.objectContaining({ message: 'The database is down, so the payment can\'t become failed' }),
    }));
  });

  it('gives the credential up, and broadcasts nothing, when the write before the broadcast fails', async () => {
    const { rail, rows, authorization } = await authorized({ failingChanges: ['settling'] });

    await expect(rail.finalize(authorization)).rejects.toThrow('can\'t become settling');

    expect(rows.get(authorization.paymentId)?.status).toBe('verified');
    expect(rpc.rawTransactions).toEqual([]);
    expect(() => (authorization as MppAuthorization).credential.expose()).toThrow(SecretDestroyedError);
  });

  it('keeps a payment settling, and broadcasts nothing, while the replay store is down at finalize', async () => {
    const flaky = createFlakyStore();
    const { rail, created, changes, authorization } = await authorized({ railSetup: await initialize({ replay: flaky.replay }) });
    flaky.down(true);

    await expect(rail.finalize(authorization)).rejects.toMatchObject({ code: 'settlement_failed', outcome: 'unknown' });

    expect(rpc.rawTransactions).toEqual([]);
    expect(changes).toEqual([beforeBroadcast(authorization.paymentId, created[0]!.transactionHash)]);
  });
});

describe('finalize and abort, run twice', () => {
  it('answers a second finalize with the stored receipt, broadcasting once', async () => {
    const { rail, settled, authorization } = await authorized();

    const first = await rail.finalize(authorization);
    const second = await rail.finalize(authorization);

    expect(second).toEqual(first);
    expect(first.settlement).toMatchObject({ status: 'settled', transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(rpc.rawTransactions).toHaveLength(1);
    expect(settled).toHaveLength(1);
  });

  it('broadcasts once for two concurrent finalizes: the other answers unknown, and the payment ends settled', async () => {
    const { rail, rows, changes, settled, authorization } = await authorized();

    const results = await Promise.allSettled([rail.finalize(authorization), rail.finalize(authorization)]);

    expect(rpc.rawTransactions).toHaveLength(1);
    const receipts = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    expect(receipts).toEqual([expect.objectContaining({ settlement: { status: 'settled', transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) } })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SettlementFailedError);
    expect(errors[0]).toMatchObject({ outcome: 'unknown' });
    expect(rows.get(authorization.paymentId)).toMatchObject({ status: 'settled', receipt: receipts[0]!.headers['payment-receipt'] });
    expect(changes.map(change => change.to)).not.toContain('failed');
    expect(settled).toHaveLength(1);
  });

  it('records a payment that settled on chain but whose booking failed as settling for review, and sends no response', async () => {
    const { rail, created, changes, authorization } = await authorized({ bookingFails: new Error('The call has no target leg to charge') });
    const hash = created[0]!.transactionHash;

    const error = await rail.finalize(authorization).catch((thrown: unknown) => thrown) as SettlementFailedError;

    expect(error).toBeInstanceOf(SettlementFailedError);
    expect(error).toMatchObject({ outcome: 'unknown', reason: 'booking_failed', network: 'eip155:42431', transaction: hash });
    expect(rpc.rawTransactions).toHaveLength(1);
    expect(rpc.transactions).toContain(hash);
    expect(changes).toEqual([beforeBroadcast(authorization.paymentId, hash), {
      paymentId: authorization.paymentId, to: 'settling', transactionHash: hash, receipt: expect.any(String), needsReview: true,
      settlementRequest: expect.objectContaining({ rail: 'mpp', transactionHash: hash }),
    }]);
    expect(Receipt.deserialize(changes[1]!.receipt!)).toMatchObject({ method: 'tempo', status: 'success', reference: hash });
    expect(fromMppSettlementRequest(changes[1]!.settlementRequest as JsonObject)).toMatchObject({ currency: pathUsdAddress, recipient, amount: '1000' });
    // The settlement follow-up books it. A second finalize answers what was stored, without broadcasting again.
    expect(await rail.finalize(authorization)).toEqual({
      headers: { 'payment-receipt': changes[1]!.receipt, 'cache-control': 'private' }, settlement: { status: 'settling', transaction: hash },
    });
    expect(rpc.rawTransactions).toHaveLength(1);
  });

  it('refuses a second finalize while a broadcast\'s outcome is unknown, without broadcasting again', async () => {
    const { rail, created, changes, authorization } = await authorized();
    rpc.broadcast('fail');
    await expect(rail.finalize(authorization)).rejects.toThrow(SettlementFailedError);

    await expect(rail.finalize(authorization)).rejects.toMatchObject({
      code: 'settlement_failed', outcome: 'unknown', transaction: created[0]!.transactionHash, network: 'eip155:42431',
    });
    expect(rpc.rawTransactions).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });

  it('refuses to finalize a payment whose broadcast failed, and gives nothing back on an abort', async () => {
    const { rail, created, changes, authorization } = await authorized();
    rpc.broadcast('refuse');
    await expect(rail.finalize(authorization)).rejects.toThrow(SettlementFailedError);

    await expect(rail.finalize(authorization)).rejects.toBeInstanceOf(InvalidPaymentStatusChangeError);
    await rail.abort(authorization);
    expect(changes).toEqual([
      beforeBroadcast(authorization.paymentId, created[0]!.transactionHash),
      { paymentId: authorization.paymentId, to: 'failed', settlementRequest: null },
    ]);
    expect(rpc.rawTransactions).toHaveLength(1);
  });

  it('gives nothing back on a second abort, refuses to finalize a cancelled payment, and refuses an abort after the settlement', async () => {
    const aborted = await authorized();
    await aborted.rail.abort(aborted.authorization);
    await aborted.rail.abort(aborted.authorization);

    expect(aborted.changes).toEqual([{ paymentId: aborted.authorization.paymentId, to: 'cancelled' }]);
    await expect(aborted.rail.finalize(aborted.authorization)).rejects.toBeInstanceOf(InvalidPaymentStatusChangeError);
    expect(rpc.rawTransactions).toEqual([]);

    const done = await authorized();
    await done.rail.finalize(done.authorization);

    await expect(done.rail.abort(done.authorization)).rejects.toThrow('can\'t be cancelled after its settlement');
    expect(done.rows.get(done.authorization.paymentId)?.status).toBe('settled');
  });
});

describe('the credential in logs and errors', () => {
  it('never writes a credential\'s header or its signed transaction to the log, or into an error\'s message', async () => {
    const lines: string[] = [];
    const captured = createLogger({ level: 'trace' }, { write: (line: string) => lines.push(line) });
    const secrets: string[] = [];
    const messages: string[] = [];
    const keep = (header: string) => {
      secrets.push(header, header.replace(/^Payment\s+/, ''), (Credential.deserialize(header).payload as { signature: string }).signature);

      return header;
    };
    // Signs a credential, keeps what must stay out of the log, and runs the call with it
    const attempt = async (
      ports: ReturnType<typeof createPorts>,
      run: (authorize: () => Promise<Authorization>) => Promise<unknown>,
      change: (header: string) => string = header => header,
    ) => {
      const quote = { ...quoteOf(), log: captured };
      const header = keep(change(keep(await pay(ports.rail, quote))));
      try {
        await run(() => ports.rail.authorize(credentialOf(ports.rail, header), quote));
      }
      catch (error) {
        messages.push((error as Error).message);
        captured.error({ error }, 'The call failed');
      }
      rpc.reset();
    };
    const ports = createPorts(setup, { log: captured });

    await attempt(ports, authorize => authorize(), tamperMppSignature);
    await attempt(ports, async authorize => {
      rpc.simulate('revert');
      await authorize();
    });
    await attempt(ports, async authorize => {
      rpc.unavailable(true);
      await authorize();
    });
    await attempt(ports, async authorize => {
      await authorize();
      await authorize();
    });
    for (const outcome of ['refuse', 'revert', 'fail', 'timeout', 'already-known'] as const) {
      await attempt(ports, async authorize => {
        const authorization = await authorize();
        rpc.broadcast(outcome);
        await ports.rail.finalize(authorization);
      });
    }
    const booking = createPorts(setup, { log: captured, bookingFails: new Error('The ledger is down') });
    await attempt(booking, async authorize => booking.rail.finalize(await authorize()));

    expect(messages).toHaveLength(10);
    expect(lines.length).toBeGreaterThanOrEqual(16);
    const written = [...lines, ...messages].join('\n');
    expect(written).toContain('booking failed');
    for (const secret of secrets)
      expect(written).not.toContain(secret);
  });
});

describe('MPP on the Redis replay store', () => {
  it('takes a credential once across two rails sharing Redis, and settles it on the first', async () => {
    const redis = await createTestRedis();
    // A second connection with the same prefix: another proxy replica
    const replica = createRedis({ url: redis.url, logger, prefix: redis.prefix });
    const firstStore = createRedisReplayStore({ redis });
    const secondStore = createRedisReplayStore({ redis: replica });
    try {
      await once(replica.client, 'ready');
      const first = createPorts(await initialize({ replay: firstStore }));
      const second = createPorts(await initialize({ replay: secondStore }));
      const quote = quoteOf();
      const header = await pay(first.rail, quote);

      const authorization = await first.rail.authorize(credentialOf(first.rail, header), quote);
      await expect(second.rail.authorize(credentialOf(second.rail, header), { ...quote, paymentId: 'pay_mpp_replica' })).rejects.toThrow('already used');
      const receipt = await first.rail.finalize(authorization);

      const hash = first.created[0]!.transactionHash!;
      expect(receipt.settlement).toEqual({ status: 'settled', transaction: hash });
      expect(first.settled).toEqual([expect.objectContaining({ paymentId: quote.paymentId, transactionHash: hash })]);
      expect(second.created).toEqual([]);
      expect(rpc.rawTransactions).toHaveLength(1);
      expect(await redis.client.exists(`${redis.prefix}mpp:authorized:${hash.toLowerCase()}`)).toBe(1);
      await expect(first.rail.authorize(credentialOf(first.rail, header), { ...quote, paymentId: 'pay_mpp_again' })).rejects.toThrow('already used');
    }
    finally {
      await Promise.all([firstStore.close(), secondStore.close()]);
      await replica.close();
      await redis.cleanup();
    }
  });
});

describe('MPP at startup', () => {
  it('stops when MPP is on without mpp.recipient', async () => {
    const before = rpc.calls.length;

    await expect(initialize({ config: { ...config, mpp: { ...config.mpp, recipient: undefined } } }))
      .rejects.toThrow('MPP is on without a recipient. Set mpp.recipient, or set mpp.enabled: false');
    expect(rpc.calls.length).toBe(before);
  });

  it('stops when the Tempo RPC answers another chain ID than mpp.network', async () => {
    rpc.answerChainId(4_217);

    await expect(initialize()).rejects.toThrow(TempoChainMismatchError);
  });

  it('stops when the Tempo RPC doesn\'t answer', async () => {
    await expect(initializeMpp({ config, secretKey: Secret.from(secretKey), store, timeoutMs: 500, rpcUrl: 'http://127.0.0.1:1' })).rejects.toThrow();
  });

  it('stops when MPP is on without an asset on mpp.network', async () => {
    await expect(initialize({ config: { ...config, assets: config.assets.filter(asset => asset.name !== 'tempo-pathusd') } }))
      .rejects.toThrow('no asset is on mpp.network');
  });

  it('refuses a secret key shorter than 32 bytes', async () => {
    await expect(initialize({ key: 'short' })).rejects.toThrow('at least 32 bytes');
  });
});

describe('the MPP settlement check', () => {
  // A payment whose broadcast timed out: the settlement request the follow-up reads
  const settlingRequest = async () => {
    const { rail, changes } = createPorts();
    const quote = quoteOf();
    const authorization = await rail.authorize(credentialOf(rail, await pay(rail, quote)), quote);
    rpc.broadcast('timeout');
    await expect(rail.finalize(authorization)).rejects.toThrow(SettlementFailedError);
    rpc.reset();

    return fromMppSettlementRequest(changes[0]!.settlementRequest as JsonObject)!;
  };

  it('settles once the receipt shows the expected transfer, and fails a reverted one', async () => {
    const clock = createFakeClock();
    const check = createMppSettlementCheck({ rpc: setup.rpc, timeoutMs: 1_000, clock });
    const succeeded = await settlingRequest();
    const reverted = await settlingRequest();

    rpc.include(succeeded.transactionHash);
    rpc.include(reverted.transactionHash, 'reverted');

    const settled = await check(succeeded);
    expect(settled).toEqual({ status: 'settled', receipt: expect.any(String) });
    expect(settled.status === 'settled' && Receipt.deserialize(settled.receipt)).toMatchObject({
      method: 'tempo', status: 'success', reference: succeeded.transactionHash, timestamp: clock.now().toISOString(),
    });
    expect(await check(reverted)).toEqual({ status: 'failed', reason: 'reverted' });
    expect(await check({ ...succeeded, amount: '999' })).toEqual({ status: 'failed', reason: 'no_transfer' });
  });

  it('waits for a transaction not found within its validity window, and fails it once the window has passed', async () => {
    const request = await settlingRequest();
    const clock = createFakeClock(new Date(request.validBefore * 1_000));
    const check = createMppSettlementCheck({ rpc: setup.rpc, timeoutMs: 1_000, clock });

    expect(await check(request)).toEqual({ status: 'pending' });
    clock.advance(mppReceiptGraceMs + 1_000);
    expect(await check(request)).toEqual({ status: 'failed', reason: 'expired' });
  });

  it('throws while the RPC doesn\'t answer, so the run tries again', async () => {
    const request = await settlingRequest();
    const check = createMppSettlementCheck({ rpc: setup.rpc, timeoutMs: 1_000, clock: createFakeClock() });
    rpc.unavailable(true);

    await expect(check(request)).rejects.toThrow();
  });
});
