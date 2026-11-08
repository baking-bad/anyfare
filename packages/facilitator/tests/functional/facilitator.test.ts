import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, Secret, type Server } from '@anyfare/common';
import { findAsset, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import {
  checkFacilitators, createFacilitator, FacilitatorUnavailableError, fromSettlementRequest, toSettlementRequest, type Facilitator,
} from '@anyfare/payments';
import { createTestNearPayer, generateNearKey, startFakeNearRpc, type FakeNearRpc, type TestNearPayer } from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { startFacilitator } from '../../src/start.js';

// Our facilitator against a fake NEAR node: the relayer and the payers have keys made here, and the
// token is the example config's USDC on NEAR testnet.

const secret = 'facilitator-secret-0123456789abcdef-0123';
const network = 'near:testnet';
const payTo = 'pay.anyfare.testnet';
// Ours, but the token hasn't registered it for storage
const unregistered = 'new.anyfare.testnet';
const relayerId = 'relay.anyfare.testnet';
const relayerKey = generateNearKey();
const near = 10n ** 24n;

// Short deadlines, so the tests reach them: a second per read and per send. A settle answers within
// its least wait, 5 s, as settleMs less 5 s is shorter.
const config: PlatformConfig = await loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({ timeouts: { connectMs: 1_000, settleMs: 1_500 } })).toString('base64'),
  },
});
const usdc = findAsset(config, 'near-usdc')!.address;
const answerMs = 5_000;

// Every line any facilitator here writes, debug included
const lines: Record<string, unknown>[] = [];
const rawLines: string[] = [];
const capture = (own: Record<string, unknown>[] = []) => createLogger({ level: 'debug' }, {
  write: (line: string) => {
    rawLines.push(line);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    lines.push(parsed);
    own.push(parsed);
  },
});
const lastLine = (msg: string, from: readonly Record<string, unknown>[] = lines): Record<string, unknown> | undefined =>
  from.filter(line => line['msg'] === msg).at(-1);

interface Stack {
  readonly rpc: FakeNearRpc;
  readonly server: Server;
  readonly url: string;
  readonly metricsUrl: string;
  // Our proxy's facilitator client, with the shared secret
  readonly client: Facilitator;
  // This facilitator's lines
  readonly lines: Record<string, unknown>[];
  close(): Promise<void>;
}

interface StackOptions {
  readonly withSecret?: boolean;
  // Whether the relayer's key is an access key of its account on the node
  readonly relayerKeyOnChain?: boolean;
  readonly relayerAmount?: bigint;
  // How long the node holds a timed-out send before its 408
  readonly timeoutMs?: number;
}

/** A fake node with the relayer, our two accounts, and the token, and a facilitator on it. */
const startStack = async ({ withSecret = true, relayerKeyOnChain = true, relayerAmount, timeoutMs = 3_000 }: StackOptions = {}): Promise<Stack> => {
  const rpc = await startFakeNearRpc({ timeoutMs });
  rpc.addAccount({ accountId: relayerId, ...relayerKeyOnChain ? { publicKey: relayerKey.publicKey } : {}, ...relayerAmount === undefined ? {} : { amount: relayerAmount } });
  rpc.addAccount({ accountId: payTo });
  rpc.addAccount({ accountId: unregistered });
  rpc.addToken({ contractId: usdc, registered: [payTo] });
  const own: Record<string, unknown>[] = [];
  const server = createApp({
    config, logger: capture(own), secret: withSecret ? Secret.from(secret) : undefined, relayer: { accountId: relayerId, secretKey: Secret.from(relayerKey.secretKey) },
    recipients: [payTo, unregistered], rpcUrls: { [network]: rpc.url }, pollMs: 200,
  });
  const ports = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  const url = `http://127.0.0.1:${ports.port}`;

  return {
    rpc, server, url, metricsUrl: `http://127.0.0.1:${ports.metricsPort}/metrics`, lines: own,
    client: createFacilitator({ name: 'near', url, networks: [network], signer: undefined, apiKey: Secret.from(secret), requestTimeoutMs: 5_000, settleTimeoutMs: 10_000 }),
    close: async () => {
      await server.close();
      await rpc.close();
    },
  };
};

let stack: Stack;
let rpc: FakeNearRpc;
let client: Facilitator;

beforeAll(async () => {
  stack = await startStack();
  ({ rpc, client } = stack);
});

afterAll(async () => {
  await stack?.close();
});

beforeEach(() => {
  rpc.reset();
});

let payers = 0;

/** A buyer with a key on the node and USDC on the token. */
const newPayer = (balance = 100_000n, on: FakeNearRpc = rpc, accountId = `buyer-${++payers}.testnet`): TestNearPayer => {
  const payer = createTestNearPayer({ accountId, rpc: on });
  on.setBalance(usdc, accountId, balance);

  return payer;
};

const requirement = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact', network, asset: usdc, amount: '10000', payTo, maxTimeoutSeconds: 60, extra: {}, ...overrides,
});

interface Paid {
  readonly payload: PaymentPayload;
  readonly requirements: PaymentRequirements;
}

/** The payer's x402 payment for a 402 with one NEAR option. */
const payment = async (payer: TestNearPayer, overrides: Partial<PaymentRequirements> = {}): Promise<Paid> => {
  const requirements = requirement(overrides);

  return { requirements, payload: await payer.paymentFor({ x402Version: 2, resource: { url: 'https://api.anyfare.test/v1/call' }, accepts: [requirements] }) };
};

const bodyOf = ({ payload, requirements }: Paid) => ({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });

// A null key: no X-API-Key header
const call = async (path: string, body?: unknown, { key = secret as string | null, at = stack.url } = {}) => {
  const response = await fetch(`${at}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...body === undefined ? {} : { 'content-type': 'application/json' }, ...key === null ? {} : { 'x-api-key': key } },
    ...body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) },
  });

  return { status: response.status, body: await response.json() as Record<string, any> };
};

const sendTxCalls = (on: FakeNearRpc = rpc) => on.calls.filter(item => item.method === 'send_tx');
const sendTxCount = (on: FakeNearRpc = rpc): number => sendTxCalls(on).length;

const metric = async (name: string, at = stack.metricsUrl): Promise<number | undefined> => {
  const match = new RegExp(`^${name.replace(/[{}]/g, '\\$&')} (\\S+)$`, 'm').exec(await (await fetch(at)).text());

  return match ? Number(match[1]) : undefined;
};

/** Makes `count` blocks on the node, as time passing on the chain. */
const passBlocks = async (on: FakeNearRpc, count: number): Promise<void> => {
  for (let index = 0; index < count; index++)
    await fetch(on.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: index, method: 'block', params: { finality: 'final' } }) });
};

describe('/supported', () => {
  it('lists exact on the config\'s NEAR network, with the relayer as its signer, as our proxy\'s startup check needs', async () => {
    expect((await call('/supported')).body).toEqual({ kinds: [{ x402Version: 2, scheme: 'exact', network }], extensions: [], signers: { 'near:*': [relayerId] } });
    await expect(checkFacilitators({ config, facilitators: [client], timeoutMs: 5_000 })).resolves.toBeUndefined();
  });
});

describe('a payment to us', () => {
  it('verifies and settles a real payer\'s payment: the relayer\'s one transaction moves the USDC', async () => {
    const payer = newPayer();
    const paid = await payment(payer);
    const received = rpc.balanceOf(usdc, payTo);

    expect(await client.verify(paid.payload, paid.requirements)).toEqual({ isValid: true, payer: payer.accountId });
    const settled = await client.settle(paid.payload, paid.requirements);

    expect(settled).toEqual({ success: true, transaction: rpc.transactions.at(-1)!.hash, network, payer: payer.accountId });
    expect(rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
    expect(rpc.balanceOf(usdc, payTo)).toBe(received + 10_000n);
    expect(sendTxCount()).toBe(1);
    expect(rpc.transactions.at(-1)).toMatchObject({
      signerId: relayerId, publicKey: relayerKey.publicKey, receiverId: payer.accountId, status: 'success',
      delegate: { senderId: payer.accountId, receiverId: usdc, transfer: { receiverId: payTo, amount: 10_000n } },
    });
  });

  it('writes one line per verify and settle: the payer, the amount, the path, the transaction, never the payment', async () => {
    const payer = newPayer();
    const paid = await payment(payer);
    const from = lines.length;

    await client.verify(paid.payload, paid.requirements);
    const { transaction } = await client.settle(paid.payload, paid.requirements);

    expect(lines.slice(from).filter(line => /payment/.test(String(line['msg'])))).toEqual([
      expect.objectContaining({ level: 30, msg: 'Verified a payment', network, payer: payer.accountId, payTo, amount: '10000', result: 'valid' }),
      expect.objectContaining({ level: 30, msg: 'Settled a payment', network, payer: payer.accountId, payTo, amount: '10000', result: 'settled', transaction }),
    ]);
    expect(rawLines.slice(from).join('\n')).not.toContain(String(paid.payload.payload['signedDelegateAction']));
  });

  it('answers a settle of a payment that landed from memory, without verifying again or sending anything', async () => {
    const payer = newPayer();
    const paid = await payment(payer);
    const first = await client.settle(paid.payload, paid.requirements);
    const calls = rpc.calls.length;

    expect(await client.settle(paid.payload, paid.requirements)).toEqual(first);
    expect(rpc.calls.length).toBe(calls);
    expect(lastLine('Answered a settle from the outcome remembered for it')).toMatchObject({ level: 30, result: 'remembered', transaction: first.transaction });
    expect(rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
  });

  it('remembers a settle for its requirement only', async () => {
    const paid = await payment(newPayer());
    await client.settle(paid.payload, paid.requirements);
    const other = { ...paid.requirements, amount: '20000' };

    // Not remembered for another amount: the scheme compares it with the signed action
    expect(await client.settle({ ...paid.payload, accepted: other }, other)).toMatchObject({ success: false, errorReason: 'invalid_exact_near_payload_amount_mismatch' });
  });
});

describe('our own check, before the scheme', () => {
  it('refuses a payment to another account, without any RPC call', async () => {
    const paid = await payment(newPayer(), { payTo: 'shop.testnet' });
    const before = rpc.calls.length;

    expect((await call('/verify', bodyOf(paid))).body).toEqual({ isValid: false, invalidReason: 'recipient_not_ours' });
    expect((await call('/settle', bodyOf(paid))).body).toEqual({ success: false, errorReason: 'recipient_not_ours', transaction: '', network });
    expect(rpc.calls.length).toBe(before);
    expect(lastLine('Refused to verify a payment that isn\'t to us')).toMatchObject({ level: 30, payTo: 'shop.testnet', amount: '10000', reason: 'recipient_not_ours' });
    expect(lastLine('Refused to settle a payment that isn\'t to us')).toMatchObject({ level: 30, payTo: 'shop.testnet', reason: 'recipient_not_ours' });
  });

  it.each([
    ['network', { network: 'near:mainnet' }],
    ['scheme', { scheme: 'upto' }],
    ['asset', { asset: 'usdc.other.testnet' }],
  ])('refuses another %s, without any RPC call', async (_name, change) => {
    const paid = await payment(newPayer());
    const changed = { ...paid.requirements, ...change } as PaymentRequirements;
    const body = bodyOf({ payload: { ...paid.payload, accepted: changed }, requirements: changed });
    const before = rpc.calls.length;

    expect((await call('/verify', body)).body).toEqual({ isValid: false, invalidReason: 'recipient_not_ours' });
    expect((await call('/settle', body)).body).toEqual({ success: false, errorReason: 'recipient_not_ours', transaction: '', network: changed.network });
    expect(rpc.calls.length).toBe(before);
  });

  it('refuses a payment whose accepted option isn\'t to us either', async () => {
    const paid = await payment(newPayer());
    const body = bodyOf({ payload: { ...paid.payload, accepted: { ...paid.requirements, payTo: 'shop.testnet' } }, requirements: paid.requirements });

    expect((await call('/verify', body)).body).toEqual({ isValid: false, invalidReason: 'recipient_not_ours' });
  });

  it('leaves the rest of the accepted option to the scheme: its extra may differ, its amount may not', async () => {
    const payer = newPayer();
    const paid = await payment(payer);
    const verify = (accepted: PaymentRequirements) => client.verify({ ...paid.payload, accepted }, paid.requirements);

    expect(await verify({ ...paid.requirements, extra: { note: 'more' }, maxTimeoutSeconds: 30 })).toEqual({ isValid: true, payer: payer.accountId });
    expect(await verify({ ...paid.requirements, amount: '1' })).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_near_amount_mismatch' });
  });
});

describe('the scheme\'s checks', () => {
  it('fails a payment to our account that the token hasn\'t registered for storage', async () => {
    const payer = newPayer();
    const paid = await payment(payer, { payTo: unregistered });

    expect(await client.verify(paid.payload, paid.requirements))
      .toEqual({ isValid: false, invalidReason: 'invalid_exact_near_recipient_not_registered_for_storage', payer: payer.accountId });
  });

  it('fails a payment the payer\'s balance doesn\'t cover, and remembers nothing, as nothing was signed', async () => {
    const payer = newPayer(5_000n);
    const paid = await payment(payer);

    expect(await client.verify(paid.payload, paid.requirements)).toEqual({ isValid: false, invalidReason: 'insufficient_funds', payer: payer.accountId });
    expect(await client.settle(paid.payload, paid.requirements)).toMatchObject({ success: false, errorReason: 'insufficient_funds', transaction: '' });
    expect(sendTxCount()).toBe(0);

    rpc.setBalance(usdc, payer.accountId, 100_000n);
    expect(await client.settle(paid.payload, paid.requirements)).toMatchObject({ success: true });
  });

  it('fails a payment from the relayer\'s own account', async () => {
    const payer = newPayer(100_000n, rpc, relayerId);
    const paid = await payment(payer);

    expect(await client.verify(paid.payload, paid.requirements)).toEqual({ isValid: false, invalidReason: 'invalid_exact_near_relayer_cannot_be_payer', payer: relayerId });
    expect(await client.settle(paid.payload, paid.requirements)).toMatchObject({ success: false, errorReason: 'invalid_exact_near_relayer_cannot_be_payer' });
    expect(sendTxCount()).toBe(0);
  });
});

describe('a NEAR RPC that doesn\'t answer the scheme\'s reads', () => {
  it('is a 503, not a verdict on the payment, and costs two calls per read at most', async () => {
    const paid = await payment(newPayer());
    rpc.unavailable(true);
    const before = rpc.calls.length;

    expect(await call('/verify', bodyOf(paid))).toEqual({
      status: 503, body: { error: { code: 'facilitator_rpc_unavailable', message: 'The NEAR RPC is unavailable: try again later' } },
    });
    expect(rpc.calls.length - before).toBe(2);
    expect(lastLine('Couldn\'t verify a payment: the NEAR RPC didn\'t answer')).toMatchObject({ level: 40, reason: 'invalid_exact_near_current_block_height_unavailable' });
    expect((await call('/settle', bodyOf(paid))).body).toMatchObject({ error: { code: 'facilitator_rpc_unavailable' } });
    // Our proxy's client takes a 503 as no answer: the payment stays where it is
    await expect(client.settle(paid.payload, paid.requirements)).rejects.toBeInstanceOf(FacilitatorUnavailableError);

    rpc.unavailable(false);
    expect(await client.settle(paid.payload, paid.requirements)).toMatchObject({ success: true });
  });
});

describe('settles through the relayer, one at a time', () => {
  // The SDK's settle, held until the test lets it go
  const holdSettles = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const settle = vi.spyOn(x402Facilitator.prototype, 'settle').mockImplementation(async () => {
      await gate;

      return { success: false, errorReason: 'settlement_failed', errorMessage: 'held by the test', transaction: '', network };
    });

    return { settle, release };
  };

  it('settles two concurrent settles of one payment once: the second answers what the first did', async () => {
    const payer = newPayer();
    const paid = await payment(payer);

    const answers = await Promise.all([client.settle(paid.payload, paid.requirements), client.settle(paid.payload, paid.requirements)]);

    expect(answers[0]).toMatchObject({ success: true });
    expect(answers[1]).toEqual(answers[0]);
    expect(sendTxCount()).toBe(1);
    expect(rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
  });

  it('lands ten concurrent settles of ten payers, with strictly rising relayer nonces, moving each balance once', async () => {
    const buyers = Array.from({ length: 10 }, () => newPayer());
    const paid = await Promise.all(buyers.map(buyer => payment(buyer)));
    const before = rpc.transactions.length;

    const answers = await Promise.all(paid.map(item => client.settle(item.payload, item.requirements)));

    expect(answers.map(answer => answer.success)).toEqual(Array.from({ length: 10 }, () => true));
    expect(new Set(answers.map(answer => answer.transaction)).size).toBe(10);
    const landed = rpc.transactions.slice(before);
    expect(landed).toHaveLength(10);
    expect(landed.every(transaction => transaction.signerId === relayerId && transaction.status === 'success')).toBe(true);
    for (let index = 1; index < landed.length; index++)
      expect(landed[index]!.nonce > landed[index - 1]!.nonce).toBe(true);
    for (const buyer of buyers)
      expect(rpc.balanceOf(usdc, buyer.accountId)).toBe(90_000n);
    expect(await metric('facilitator_settle_queue_depth')).toBe(0);
  });

  it('refuses a settle with a 503 while 32 wait for the relayer, and lets verifies through', async () => {
    const body = bodyOf(await payment(newPayer()));
    const { settle, release } = holdSettles();
    try {
      const waiting = Array.from({ length: 32 }, () => call('/settle', body));
      await vi.waitFor(async () => expect(await metric('facilitator_settle_queue_depth')).toBe(32));

      expect(await call('/settle', body)).toEqual({ status: 503, body: { error: { code: 'facilitator_busy', message: 'The relayer is busy: settle again later' } } });
      expect((await call('/verify', body)).status).toBe(200);
      release();
      expect((await Promise.all(waiting)).map(answer => answer.status)).toEqual(Array.from({ length: 32 }, () => 200));
      expect(settle).toHaveBeenCalledTimes(32);
    }
    finally {
      settle.mockRestore();
    }
    expect(await metric('facilitator_settle_queue_depth')).toBe(0);
  });

  it('cancels a settle the relayer hasn\'t signed by its deadline: it answers a 503, and never sends', async () => {
    const first = bodyOf(await payment(newPayer()));
    const payer = newPayer();
    const second = bodyOf(await payment(payer));
    const { settle, release } = holdSettles();
    try {
      const held = call('/settle', first);
      await vi.waitFor(async () => expect(await metric('facilitator_settle_queue_depth')).toBe(1));
      const started = performance.now();

      expect(await call('/settle', second)).toEqual({ status: 503, body: { error: { code: 'facilitator_busy', message: 'The relayer is busy: settle again later' } } });
      expect(performance.now() - started).toBeGreaterThanOrEqual(answerMs - 100);
      expect(lastLine('A settle didn\'t reach the relayer in time: nothing was sent')).toMatchObject({ level: 40, result: 'busy' });
      release();
      await held;
      await vi.waitFor(async () => expect(await metric('facilitator_settle_queue_depth')).toBe(0));
      // Its turn came, cancelled: the SDK never saw it, and the node never saw a transaction for it
      expect(settle).toHaveBeenCalledTimes(1);
    }
    finally {
      settle.mockRestore();
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(sendTxCount()).toBe(0);
    expect(rpc.transactions.some(transaction => transaction.delegate.senderId === payer.accountId)).toBe(false);
  }, 15_000);

  it.concurrent('takes the next settle within the send\'s deadline while a dropped transaction is polled', async () => {
    const own = await startStack();
    try {
      const dropped = await payment(newPayer(100_000n, own.rpc));
      const next = await payment(newPayer(100_000n, own.rpc));
      own.rpc.broadcast('drop');
      const first = own.client.settle(dropped.payload, dropped.requirements);
      await vi.waitFor(() => expect(sendTxCount(own.rpc)).toBe(1));
      const started = performance.now();

      expect(await own.client.settle(next.payload, next.requirements)).toMatchObject({ success: true });

      expect(performance.now() - started).toBeLessThan(config.timeouts.connectMs + 800);
      // The dropped one's resend then finds its nonce taken, before any answer: a failed settlement
      expect(await first).toMatchObject({ success: false, errorReason: 'settlement_failed' });
    }
    finally {
      await own.close();
    }
  }, 15_000);
});

describe('the relayer\'s transaction', () => {
  // As the settlement follow-up repeats a settle, from what the proxy stored
  const storedOf = (paid: Paid) => fromSettlementRequest(toSettlementRequest(paid.payload, paid.requirements))!;

  it.concurrent('lands after a transient 503: the client sends it once more', async () => {
    const own = await startStack();
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('fail');

      const answer = await own.client.settle(paid.payload, paid.requirements);

      expect(answer).toEqual({ success: true, transaction: own.rpc.transactions[0]!.hash, network, payer: payer.accountId });
      expect(sendTxCount(own.rpc)).toBe(2);
      expect(own.rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
      expect(await own.client.settle(paid.payload, paid.requirements)).toEqual(answer);
      expect(sendTxCount(own.rpc)).toBe(2);
    }
    finally {
      await own.close();
    }
  });

  it.concurrent('resends a lost transaction once the node is back: it lands without help', async () => {
    const own = await startStack();
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('drop');
      const settled = own.client.settle(paid.payload, paid.requirements);
      await vi.waitFor(() => expect(sendTxCount(own.rpc)).toBe(1));
      own.rpc.unavailable(true);
      await new Promise(resolve => setTimeout(resolve, 2_000));
      own.rpc.unavailable(false);

      expect(await settled).toEqual({ success: true, transaction: own.rpc.transactions[0]!.hash, network, payer: payer.accountId });
      expect(sendTxCount(own.rpc)).toBeGreaterThan(1);
      expect(own.rpc.transactions).toHaveLength(1);
      expect(own.rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
    }
    finally {
      await own.close();
    }
  }, 15_000);

  it.concurrent('answers pending with its hash while the node is down past the deadline, then settled once the resend lands', async () => {
    const own = await startStack();
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('drop');
      const started = performance.now();
      const answer = own.client.settle(storedOf(paid).paymentPayload, storedOf(paid).paymentRequirements);
      await vi.waitFor(() => expect(sendTxCount(own.rpc)).toBe(1));
      own.rpc.unavailable(true);

      const pending = await answer;

      expect(performance.now() - started).toBeGreaterThanOrEqual(answerMs - 100);
      expect(pending).toEqual({ success: false, errorReason: 'settlement_pending', transaction: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/), network, payer: payer.accountId });
      expect(lastLine('A settlement is pending: the relayer\'s transaction isn\'t final yet', own.lines)).toMatchObject({ result: 'pending', transaction: pending.transaction });
      // A repeat while it's in flight: pending, from memory
      expect(await own.client.settle(paid.payload, paid.requirements)).toEqual(pending);

      own.rpc.unavailable(false);
      await vi.waitFor(() => expect(own.rpc.transactions).toHaveLength(1), { timeout: 5_000 });
      await vi.waitFor(() => expect(lastLine('A settle that had answered became final', own.lines)).toMatchObject({ result: 'settled', transaction: pending.transaction }));
      expect(await own.client.settle(paid.payload, paid.requirements)).toEqual({ success: true, transaction: pending.transaction, network, payer: payer.accountId });
      expect(own.rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
      expect(await metric('facilitator_settles_total{result="pending"}', own.metricsUrl)).toBe(1);
    }
    finally {
      await own.close();
    }
  }, 20_000);

  it.concurrent('stays pending while lookups get no answer, even past the expiry, and settles once they show the outcome', async () => {
    // The node holds its answer for long; the transfer lands at once
    const own = await startStack({ timeoutMs: 60_000 });
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('timeout');
      own.rpc.unavailable(true, { methods: ['tx'] });

      const pending = await own.client.settle(paid.payload, paid.requirements);

      expect(pending).toMatchObject({ success: false, errorReason: 'settlement_pending' });
      expect(own.rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
      await passBlocks(own.rpc, 80);
      await new Promise(resolve => setTimeout(resolve, 1_000));
      // No evidence: still pending, never "not included"
      expect(await own.client.settle(paid.payload, paid.requirements)).toEqual(pending);

      own.rpc.unavailable(false);
      await vi.waitFor(() => expect(lastLine('A settle that had answered became final', own.lines)).toMatchObject({ result: 'settled' }), { timeout: 5_000 });
      expect(await own.client.settle(paid.payload, paid.requirements)).toEqual({ success: true, transaction: pending.transaction, network, payer: payer.accountId });
    }
    finally {
      await own.close();
    }
  }, 20_000);

  it.concurrent('keeps a dropped transaction\'s nonce from the next one, and forgets it once the node refuses its resend', async () => {
    const own = await startStack();
    try {
      const chainNonce = own.rpc.nonceOf(relayerId, relayerKey.publicKey)!;
      const first = newPayer(100_000n, own.rpc);
      const second = newPayer(100_000n, own.rpc);
      const dropped = await payment(first);
      const next = await payment(second);
      own.rpc.broadcast('drop');
      const answer = call('/settle', bodyOf(dropped), { at: own.url });
      await vi.waitFor(() => expect(sendTxCount(own.rpc)).toBe(1));

      // The chain's nonce lags: the next transaction takes two above it
      expect(await own.client.settle(next.payload, next.requirements)).toMatchObject({ success: true });
      expect(own.rpc.transactions[0]!.nonce).toBe(chainNonce + 2n);

      // The dropped one's resend comes after: its nonce is taken, so it can never be included. No
      // answer had gone out yet: a failed settlement, with our transaction's hash.
      const refused = await answer;
      expect(refused).toEqual({
        status: 200,
        body: {
          success: false, errorReason: 'settlement_failed', errorMessage: expect.stringMatching(/^Transaction nonce \d+ must be larger than nonce of the used access key \d+$/),
          transaction: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/), network, payer: first.accountId,
        },
      });
      expect(lastLine('The node refused the relayer\'s transaction: the settlement failed, and nothing was included', own.lines))
        .toMatchObject({ level: 40, result: 'relayer_refused', transaction: refused.body['transaction'] });
      // Not remembered: the same signature settles afresh, and lands
      expect(await own.client.settle(dropped.payload, dropped.requirements)).toMatchObject({ success: true });
      expect(own.rpc.transactions.map(transaction => transaction.nonce)).toEqual([chainNonce + 2n, chainNonce + 3n]);
      expect(own.rpc.balanceOf(usdc, first.accountId)).toBe(90_000n);
      expect(own.rpc.balanceOf(usdc, second.accountId)).toBe(90_000n);
    }
    finally {
      await own.close();
    }
  }, 15_000);

  it.concurrent('is polled and found when the node holds the answer past the send\'s deadline, and the next nonce is higher', async () => {
    const own = await startStack({ timeoutMs: 3_000 });
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('timeout');

      const answer = await own.client.settle(paid.payload, paid.requirements);

      expect(answer).toEqual({ success: true, transaction: own.rpc.transactions[0]!.hash, network, payer: payer.accountId });
      expect(own.rpc.calls.some(item => item.method === 'tx')).toBe(true);
      const next = await payment(newPayer(100_000n, own.rpc));
      expect(await own.client.settle(next.payload, next.requirements)).toMatchObject({ success: true });
      expect(own.rpc.transactions[1]!.nonce > own.rpc.transactions[0]!.nonce).toBe(true);
    }
    finally {
      await own.close();
    }
  });

  it.concurrent('lands after the node\'s 408: the client sends it again, and the node answers its outcome', async () => {
    const own = await startStack({ timeoutMs: 200 });
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('timeout');

      expect(await own.client.settle(paid.payload, paid.requirements)).toMatchObject({ success: true, transaction: own.rpc.transactions[0]!.hash });
      expect(sendTxCount(own.rpc)).toBe(2);
      expect(own.rpc.transactions).toHaveLength(1);
    }
    finally {
      await own.close();
    }
  });

  it.concurrent('answers pending for a transaction the node never takes, then fails it once the node says so past the expiry', async () => {
    const own = await startStack();
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      // The node never takes it, nor any resend
      own.rpc.broadcast('drop', { times: 1_000 });

      const pending = await own.client.settle(paid.payload, paid.requirements);

      expect(pending).toMatchObject({ success: false, errorReason: 'settlement_pending', payer: payer.accountId });
      expect(sendTxCount(own.rpc)).toBeGreaterThan(1);
      expect(own.rpc.transactions).toEqual([]);
      // Past the delegate action's max_block_height and 10 more: it can no longer execute
      await passBlocks(own.rpc, 80);
      await vi.waitFor(() => expect(lastLine('A settle that had answered became final', own.lines)).toMatchObject({ result: 'failed' }), { timeout: 8_000 });

      // It names the transaction, so our proxy's client, which kept the pending answer, takes the failure as final
      const failed = {
        success: false, errorReason: 'settlement_failed', errorMessage: 'not included before the delegate action expired', transaction: pending.transaction, network, payer: payer.accountId,
      };
      expect(await own.client.settle(paid.payload, paid.requirements)).toEqual(failed);
      expect(lastLine('Answered a settle from the outcome remembered for it', own.lines)).toMatchObject({ result: 'remembered', reason: 'settlement_failed' });
      expect(own.rpc.balanceOf(usdc, payer.accountId)).toBe(100_000n);
    }
    finally {
      await own.close();
    }
  }, 20_000);

  it.concurrent('is signed again with a new nonce after an InvalidNonce refusal, and lands', async () => {
    const own = await startStack();
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('refuse', { refusal: 'invalid-nonce' });

      const answer = await own.client.settle(paid.payload, paid.requirements);

      expect(answer).toEqual({ success: true, transaction: own.rpc.transactions[0]!.hash, network, payer: payer.accountId });
      const [refused, landed] = sendTxCalls(own.rpc);
      expect(landed).toBeDefined();
      expect(refused!.params).not.toEqual(landed!.params);
      expect(own.rpc.transactions).toHaveLength(1);
    }
    finally {
      await own.close();
    }
  });

  it.each([
    ['refuses it twice for its nonce', { times: 2, refusal: 'invalid-nonce' } as const, /^Transaction nonce \d+ must be larger than nonce of the used access key \d+$/],
    ['refuses it as expired', { refusal: 'expired' } as const, /^Transaction has expired$/],
  ])('fails the settlement, remembering nothing, when the node %s at the first send', async (_name, refusal, message) => {
    const own = await startStack();
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('refuse', refusal);
      const stored = storedOf(paid);

      // Our proxy's client takes it as the facilitator's answer: the settlement failed, nothing was charged
      const answer = await own.client.settle(stored.paymentPayload, stored.paymentRequirements);

      expect(answer).toEqual({
        success: false, errorReason: 'settlement_failed', errorMessage: expect.stringMatching(message), transaction: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
        network, payer: payer.accountId,
      });
      expect(own.rpc.transactions).toEqual([]);
      // Not remembered: the buyer's retry with the same signature settles afresh
      expect(await own.client.settle(paid.payload, paid.requirements)).toEqual({
        success: true, transaction: own.rpc.transactions[0]!.hash, network, payer: payer.accountId,
      });
      expect(own.rpc.balanceOf(usdc, payer.accountId)).toBe(90_000n);
    }
    finally {
      await own.close();
    }
  });

  it.concurrent('polls on after a resend refused for another reason, until it has evidence', async () => {
    const own = await startStack();
    try {
      const payer = newPayer(100_000n, own.rpc);
      const paid = await payment(payer);
      own.rpc.broadcast('drop');
      const answer = own.client.settle(paid.payload, paid.requirements);
      await vi.waitFor(() => expect(sendTxCount(own.rpc)).toBe(1));
      // The first resend is refused as by one node of a pool; the next one lands
      own.rpc.broadcast('refuse', { refusal: 'expired' });

      expect(await answer).toMatchObject({ success: true, transaction: own.rpc.transactions[0]!.hash });
      expect(sendTxCount(own.rpc)).toBe(3);
    }
    finally {
      await own.close();
    }
  }, 15_000);

  it.concurrent('looks a transaction up with wait_until NONE only: under FINAL the node answers an unknown one with a 408', async () => {
    const own = await startStack({ timeoutMs: 300 });
    try {
      const paid = await payment(newPayer(100_000n, own.rpc));
      own.rpc.broadcast('drop', { times: 1_000 });
      void own.client.settle(paid.payload, paid.requirements).catch(() => undefined);
      await vi.waitFor(() => expect(own.rpc.calls.filter(item => item.method === 'tx').length).toBeGreaterThan(2), { timeout: 5_000 });
      const lookups = own.rpc.calls.filter(item => item.method === 'tx');
      const hash = (lookups[0]!.params as Record<string, string>)['tx_hash']!;

      expect(lookups.every(item => (item.params as Record<string, unknown>)['wait_until'] === 'NONE')).toBe(true);
      const final = await fetch(own.rpc.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: hash, sender_account_id: relayerId, wait_until: 'FINAL' } }) });
      expect(final.status).toBe(408);
      expect(await final.json()).toMatchObject({ error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } });
    }
    finally {
      await own.close();
    }
  }, 15_000);

  it.concurrent('stops at close: a transaction in flight answers pending, is logged with its hash, and nothing is sent after', async () => {
    const own = await startStack();
    const payer = newPayer(100_000n, own.rpc);
    const paid = await payment(payer);
    own.rpc.broadcast('drop', { times: 1_000 });
    const answer = call('/settle', bodyOf(paid), { at: own.url });
    await vi.waitFor(() => expect(sendTxCount(own.rpc)).toBe(1));
    await new Promise(resolve => setTimeout(resolve, config.timeouts.connectMs + 200));

    await own.server.close();
    const sent = sendTxCount(own.rpc);

    expect((await answer).body).toMatchObject({ success: false, errorReason: 'settlement_pending', payer: payer.accountId });
    expect(lastLine('A relayer transaction was in flight at shutdown', own.lines)).toMatchObject({ level: 40, transaction: (await answer).body['transaction'] });
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(sendTxCount(own.rpc)).toBe(sent);
    await own.rpc.close();
  }, 15_000);
});

describe('the shared secret', () => {
  it('refuses a call without X-API-Key, or with a wrong one, with 401, comparing it timing-safe', async () => {
    const paid = await payment(newPayer());
    const equals = vi.spyOn(Secret.prototype, 'equals');
    const before = rpc.calls.length;
    try {
      for (const key of [null, '', 'wrong', `${secret.slice(0, -1)}x`, `${secret}x`]) {
        for (const [path, body] of [['/supported', undefined], ['/verify', bodyOf(paid)], ['/settle', bodyOf(paid)]] as const) {
          expect(await call(path, body, { key })).toEqual({ status: 401, body: { error: { code: 'unauthorized', message: 'The facilitator needs the X-API-Key header' } } });
        }
      }
      expect(equals).toHaveBeenCalled();
    }
    finally {
      equals.mockRestore();
    }
    expect(rpc.calls.length).toBe(before);
  });

  it('refuses every call when the facilitator has no secret', async () => {
    const open = await startStack({ withSecret: false });
    try {
      expect((await call('/supported', undefined, { at: open.url })).status).toBe(401);
    }
    finally {
      await open.close();
    }
  });
});

describe('a request\'s body', () => {
  it('may not pass 64 KiB', async () => {
    const paid = await payment(newPayer());
    const body = bodyOf({ ...paid, payload: { ...paid.payload, resource: { url: 'https://api.anyfare.test/v1/call', description: 'x'.repeat(70_000) } } });

    expect(await call('/verify', body)).toMatchObject({ status: 413, body: { error: { code: 'request_too_large' } } });
  });

  it.each([
    ['an unknown field', (body: Record<string, any>) => ({ ...body, extra: true })],
    ['x402 version 1', (body: Record<string, any>) => ({ ...body, x402Version: 1 })],
    ['no signed delegate action', (body: Record<string, any>) => ({ ...body, paymentPayload: { ...body['paymentPayload'], payload: {} } })],
    ['an amount that isn\'t atomic', (body: Record<string, any>) => ({ ...body, paymentRequirements: { ...body['paymentRequirements'], amount: '0.01' } })],
  ])('is refused with %s', async (_name, change) => {
    const body = change(bodyOf(await payment(newPayer())));

    expect(await call('/verify', body)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await call('/settle', body)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });
});

describe('an error the SDK throws', () => {
  it('is a 500 with a fixed message, and its line has no URL path', async () => {
    const paid = await payment(newPayer());
    const verify = vi.spyOn(x402Facilitator.prototype, 'verify').mockRejectedValueOnce(new Error(`The call to ${rpc.url}/v1/rpc-key-in-path failed`));
    try {
      expect(await call('/verify', bodyOf(paid))).toEqual({ status: 500, body: { error: { code: 'facilitator_failed', message: 'The facilitator failed' } } });
    }
    finally {
      verify.mockRestore();
    }
    const line = lastLine('Request failed');
    expect(line).toMatchObject({ level: 50, error: { code: 'facilitator_failed', reason: `Error: The call to ${new URL(rpc.url).host} failed` } });
    expect(JSON.stringify(line)).not.toContain('rpc-key-in-path');
  });
});

describe('readiness', () => {
  it('is ready while the RPC answers block and the relayer\'s key is a full-access key, with its NEAR on a gauge', async () => {
    expect(await call('/_/ready', undefined, { key: null })).toEqual({ status: 200, body: { status: 'ready', checks: { 'near-rpc': 'ok', 'near-relayer': 'ok' } } });
    expect(await metric('facilitator_relayer_balance_near')).toBe(10);

    rpc.unavailable(true);
    expect(await call('/_/ready', undefined, { key: null }))
      .toEqual({ status: 503, body: { status: 'not_ready', checks: { 'near-rpc': 'failed', 'near-relayer': 'failed' } } });
    expect(JSON.stringify(lines.filter(line => line['msg'] === 'Readiness check failed').slice(-2))).not.toContain(rpc.url);
  });

  it('is 503 while the relayer\'s key isn\'t one of its account\'s keys', async () => {
    const own = await startStack({ relayerKeyOnChain: false });
    try {
      expect(await call('/_/ready', undefined, { key: null, at: own.url }))
        .toEqual({ status: 503, body: { status: 'not_ready', checks: { 'near-rpc': 'ok', 'near-relayer': 'failed' } } });
      expect(lastLine('Readiness check failed', own.lines)).toMatchObject({ check: 'near-relayer', error: { message: `FACILITATOR_NEAR_KEY isn't an access key of ${relayerId}` } });
    }
    finally {
      await own.close();
    }
  });

  it('warns once a minute at most while the relayer holds under 0.05 NEAR', async () => {
    const own = await startStack({ relayerAmount: near / 100n });
    try {
      expect((await call('/_/ready', undefined, { key: null, at: own.url })).status).toBe(200);
      expect((await call('/_/ready', undefined, { key: null, at: own.url })).status).toBe(200);

      expect(own.lines.filter(line => line['msg'] === 'The relayer holds under 0.05 NEAR: its transactions may not pay their gas'))
        .toEqual([expect.objectContaining({ level: 40, relayer: relayerId, balance: 0.01 })]);
      expect(await metric('facilitator_relayer_balance_near', own.metricsUrl)).toBe(0.01);
    }
    finally {
      await own.close();
    }
  });
});

describe('metrics', () => {
  it('counts verifies and settles by result, and times the settles that weren\'t remembered', async () => {
    const text = await (await fetch(stack.metricsUrl)).text();

    expect(text).toMatch(/facilitator_verifies_total\{result="valid"\} [1-9]/);
    expect(text).toMatch(/facilitator_verifies_total\{result="recipient_not_ours"\} [1-9]/);
    expect(text).toMatch(/facilitator_verifies_total\{result="insufficient_funds"\} [1-9]/);
    expect(text).toMatch(/facilitator_verifies_total\{result="rpc_unavailable"\} [1-9]/);
    expect(text).toMatch(/facilitator_settles_total\{result="settled"\} [1-9]/);
    expect(text).toMatch(/facilitator_settles_total\{result="remembered"\} [1-9]/);
    expect(text).toMatch(/facilitator_settles_total\{result="busy"\} [1-9]/);
    expect(text).toMatch(/facilitator_settles_total\{result="rpc_unavailable"\} [1-9]/);
    expect(text).toMatch(/facilitator_settle_duration_seconds_count\{outcome="settled"\} [1-9]/);
    expect(text).toMatch(/facilitator_settle_duration_seconds_count\{outcome="busy"\} [1-9]/);
    expect(text).not.toMatch(/facilitator_settle_duration_seconds_count\{outcome="remembered"\}/);
    expect(text).toMatch(/^facilitator_settle_queue_depth 0$/m);
  });
});

describe('starting', () => {
  const envFor = (on: FakeNearRpc): Record<string, string | undefined> => ({
    CONFIG_PATH: 'config/example.yaml', FACILITATOR_SECRET: secret, FACILITATOR_NEAR_ACCOUNT: relayerId, FACILITATOR_NEAR_KEY: relayerKey.secretKey,
    NEAR_RPC_URLS: `${network}=${on.url}/v1/rpc-key-in-path`, HOST: '127.0.0.1', PORT: '0', METRICS_PORT: '0',
  });

  it('checks the relayer, takes the key out of the environment, and logs the relayer, the recipients, and the RPC\'s host', async () => {
    const env = envFor(rpc);

    const started = await startFacilitator({ env, logger: capture() });
    try {
      const line = lastLine('Started');
      expect(line).toMatchObject({ app: 'facilitator', environment: 'staging', network, relayer: relayerId, recipients: [payTo], rpcHosts: [new URL(rpc.url).host] });
      expect(JSON.stringify(line)).not.toContain('rpc-key-in-path');
      expect('FACILITATOR_NEAR_KEY' in env).toBe(false);
      expect(rpc.calls.some(item => item.method === 'query' && (item.params as Record<string, unknown>)['request_type'] === 'view_access_key')).toBe(true);
    }
    finally {
      await started.close();
    }
  });

  it.each([
    ['whose key isn\'t one of its account\'s keys', { relayerKeyOnChain: false }, `FACILITATOR_NEAR_KEY isn't an access key of ${relayerId} on near:testnet`],
    ['under 0.05 NEAR', { relayerAmount: near / 100n }, `The relayer ${relayerId} holds 0.01 NEAR, under the 0.05 NEAR its transactions' gas needs`],
  ])('doesn\'t start with a relayer %s', async (_name, options, message) => {
    const own = await startStack(options);
    try {
      const failure = startFacilitator({ env: envFor(own.rpc), logger: createLogger({ level: 'silent' }) });

      await expect(failure).rejects.toThrow(message);
      await expect(failure).rejects.not.toThrow(relayerKey.secretKey.slice('ed25519:'.length));
    }
    finally {
      await own.close();
    }
  });

  it('doesn\'t start without the relayer\'s account', async () => {
    const own = await startFakeNearRpc();
    try {
      await expect(startFacilitator({ env: envFor(own), logger: createLogger({ level: 'silent' }) }))
        .rejects.toThrow(`The relayer account ${relayerId} doesn't exist on near:testnet`);
    }
    finally {
      await own.close();
    }
  });

  it('refuses a short secret', async () => {
    const env = { ...envFor(rpc), FACILITATOR_SECRET: 'short' };

    await expect(startFacilitator({ env, logger: createLogger({ level: 'silent' }) })).rejects.toThrow('FACILITATOR_SECRET must be at least 32 characters');
  });
});

describe('the relayer\'s key', () => {
  it('never reaches a line', () => {
    const all = rawLines.join('\n');

    expect(lines.length).toBeGreaterThan(20);
    expect(all).not.toContain(relayerKey.secretKey);
    expect(all).not.toContain(relayerKey.secretKey.slice('ed25519:'.length));
  });
});
