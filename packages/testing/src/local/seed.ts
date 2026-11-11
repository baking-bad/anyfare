import { sql } from 'drizzle-orm';
import { encodePaymentResponseHeader } from '@x402/core/http';
import { Receipt } from 'mppx';

import { systemClock, type IdGenerator, type MicroUsd } from '@anyfare/common';
import {
  createPaidWith, generateApiKey, hashApiKey, type Asset, type PlatformConfig, type RandomSource, type TopupStatus,
} from '@anyfare/core';
import {
  createAccountRepository, createApiKeyRepository, createCallRepository, createLedger, createPaymentKeyRepository, createPaymentRepository,
  createRoutingRepository, createStatsCounter, createStatsRepository, type Postgres,
} from '@anyfare/db';
import { routingQuote } from '@anyfare/payments';
import { createAllStats, createRecentStats } from '@anyfare/workers';

import { createFakeClock } from '../clock.js';
import { createSeededRandom, type SeededRandom } from './random.js';
import {
  checkedOnPaidHost, checkedServices, fakeTransactionHash, longHost, merchantAddress, payerAddresses, quietAgoMs, quietEndpoint, quietService, seedAccountPrefix, seedKeyPrefix, seedLedgerPrefix, seedRequestPrefix,
  services, veryLongPath, veryLongPathService, type ChainName, type EndpointDefinition, type ServiceDefinition,
} from './seedData.js';
import { creditedFor, seedTopup, type TopupSeeding } from './seedTopups.js';
import { wipeSeededRows } from './wipe.js';

// The seed: about two thousand calls over the last 30 UTC days, written through the repositories and the
// ledger the apps use, so each row is one the apps could have written. The same seed makes the same
// data, with its times counted back from `now`.

export const defaultSeed = 20_261_111;
export const defaultCallCount = 2_000;

const minuteMs = 60_000;
const hourMs = 3_600_000;
const dayMs = 86_400_000;

export interface SeedOptions {
  readonly postgres: Postgres;
  readonly config: PlatformConfig;
  // Default: the system clock
  readonly now?: Date;
  readonly seed?: number;
  readonly calls?: number;
  // Seed only the services a check listed, with no call, account or top-up. Default: false.
  readonly checkedOnly?: boolean;
  readonly log?: (line: string) => void;
}

export interface SeedSummary {
  // Calls by how the buyer paid: near, base, solana, tempo, credits
  readonly callsByWay: Readonly<Record<string, number>>;
  readonly calls: number;
  readonly freeCalls: number;
  readonly accounts: number;
  readonly topups: number;
  readonly services: number;
  readonly endpoints: number;
  // The hosts listed only by a check, and their endpoints, those on a paid host not counted among the hosts
  readonly checkedServices: number;
  readonly checkedEndpoints: number;
  // A key of the first account, so the console can be tried: made up, and good only against this database
  readonly masterKey: string;
  readonly paymentKey: string;
}

interface ChainSetting {
  readonly name: ChainName;
  readonly rail: 'x402' | 'mpp';
  readonly asset: Asset;
}

type Way = { readonly kind: 'credits' } | { readonly kind: 'chain'; readonly chain: ChainSetting };

interface Failure {
  // The API's status, or none for a timeout or a call that never reached it
  readonly status: number | undefined;
  readonly leg: 'failed' | 'unknown' | 'none';
  readonly latencyMs: number;
}

interface SeedAccount {
  readonly id: string;
  readonly createdAt: Date;
  readonly keys: readonly { readonly id: string; readonly dailyBudget: bigint }[];
  readonly spend: bigint;
  readonly firstCall: Date;
}

interface PlannedCall {
  readonly index: number;
  readonly at: Date;
  readonly paymentId: string;
  readonly service: ServiceDefinition;
  readonly serviceIndex: number;
  readonly endpoint: EndpointDefinition;
  readonly path: string;
  readonly way: Way;
  readonly payer: string | undefined;
  readonly account: number | undefined;
  readonly key: number | undefined;
  readonly quote: bigint;
  readonly fee: bigint;
  readonly arrivalMs: number;
  readonly latencyMs: number;
  // The API's status: none for a timeout or a call that never reached it
  readonly status: number | undefined;
  readonly failure: Failure | undefined;
  // How a free call on a chain ended
  readonly freeStatus: 'cancelled' | 'failed';
  readonly withDetails: boolean;
}

const uuidOf = (random: SeededRandom): string => {
  const hex = random.hex(32);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const chainSettings = (config: PlatformConfig): Readonly<Record<ChainName, ChainSetting>> => {
  const assetOf = (chain: ChainName): Asset => {
    const asset = chain === 'tempo'
      ? config.assets.find(candidate => candidate.network.id === config.mpp.network.id)
      : config.assets.find(candidate => candidate.network.chain === chain);
    if (!asset)
      throw new Error(`The platform config has no asset on ${chain}, which the seed pays on`);

    return asset;
  };

  return {
    near: { name: 'near', rail: 'x402', asset: assetOf('near') },
    base: { name: 'base', rail: 'x402', asset: assetOf('base') },
    solana: { name: 'solana', rail: 'x402', asset: assetOf('solana') },
    tempo: { name: 'tempo', rail: 'mpp', asset: assetOf('tempo') },
  };
};

// --- The plan: every call, decided before anything is written ---

const hourWeights = [3, 2, 2, 2, 3, 4, 6, 8, 10, 11, 12, 12, 12, 12, 11, 10, 9, 8, 7, 6, 5, 5, 4, 3];
// How many of the oldest calls were made before details were kept
const callsWithoutDetails = 40;

/** The times of the calls: growing toward today, with some in the last minutes and hours. */
const planTimes = (random: SeededRandom, end: Date, total: number): readonly Date[] => {
  const todayStart = Math.floor(end.getTime() / dayMs) * dayMs;
  const elapsed = Math.max((end.getTime() - todayStart) / dayMs, 0.03);
  const recent = [
    ...Array.from({ length: 6 }, () => end.getTime() - random.int(5 * minuteMs)),
    ...Array.from({ length: 8 }, () => end.getTime() - random.int(25 * minuteMs)),
    ...Array.from({ length: 30 }, () => end.getTime() - random.int(4 * hourMs)),
  ];
  const base = total - recent.length;
  const weights = Array.from({ length: 30 }, (_, day) => {
    const dayStart = todayStart - (29 - day) * dayMs;
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay()) ? 0.7 : 1;

    return (1 + day * 0.1) * weekend * (0.85 + random.next() * 0.3) * (day === 29 ? elapsed : 1);
  });
  const sum = weights.reduce((all, weight) => all + weight, 0);
  const times: number[] = [...recent];
  weights.forEach((weight, day) => {
    const dayStart = todayStart - (29 - day) * dayMs;
    const count = Math.round(base * weight / sum);
    const lastHour = day === 29 ? Math.floor((end.getTime() - dayStart) / hourMs) : 23;
    const hours = hourWeights.slice(0, lastHour + 1);
    for (let call = 0; call < count; call++)
      times.push(Math.min(dayStart + random.weighted(hours) * hourMs + random.int(hourMs), end.getTime()));
  });

  return times.sort((a, b) => a - b).map(time => new Date(time));
};

const failures: readonly Failure[] = [
  { status: 500, leg: 'failed', latencyMs: 240 },
  { status: 502, leg: 'failed', latencyMs: 900 },
  { status: 404, leg: 'failed', latencyMs: 130 },
  { status: undefined, leg: 'unknown', latencyMs: 30_000 },
  { status: undefined, leg: 'none', latencyMs: 0 },
];
const failureWeights = [30, 25, 20, 15, 10];

const latencyOf = (random: SeededRandom, endpoint: EndpointDefinition): number => {
  const typical = 90 + (endpoint.path.length * 37) % 420;
  const slow = random.next() < 0.03 ? 6 : 1;

  return Math.round(typical * (0.7 + random.next() * 0.8) * slow);
};

interface Plan {
  readonly calls: readonly PlannedCall[];
  readonly payers: Readonly<Record<ChainName, readonly string[]>>;
  readonly merchants: readonly string[];
  readonly accountCalls: readonly (readonly PlannedCall[])[];
}

const accountWeights = [30, 22, 18, 14, 10, 6];
const keyCounts = [2, 3, 1, 2, 2, 1];
const wayChains: readonly ChainName[] = ['near', 'base', 'solana', 'tempo'];
// NEAR is the most used, then Base; Credits is the last column
const wayWeights = [38, 20, 10, 10, 22];

const planCalls = (random: SeededRandom, config: PlatformConfig, end: Date, total: number): Plan => {
  const chains = chainSettings(config);
  const times = planTimes(random, end, total);
  const payers = Object.fromEntries(wayChains.map(chain => [chain, payerAddresses(chain, 60, random)])) as Record<ChainName, readonly string[]>;
  const merchants = services.map((service, index) => merchantAddress(service.paidOn, index, random));
  const serviceWeights = services.map(service => service.weight);
  const longHostIndex = services.findIndex(service => service.host === longHost);
  const pathCallIndex = times.findIndex(time => time.getTime() >= end.getTime() - 12 * dayMs);
  const longHostCalls = new Set(Array.from({ length: 5 }, () => random.between(60, Math.floor(times.length * 0.8))));
  const payerWeights = Array.from({ length: 50 }, (_, rank) => 1 / (rank + 1) ** 1.05);

  const draft = times.map((at, index) => {
    const serviceIndex = index === pathCallIndex ? services.findIndex(service => service.host === veryLongPathService) : longHostCalls.has(index) ? longHostIndex : random.weighted(serviceWeights);
    const service = services[serviceIndex]!;
    const endpoint = index === pathCallIndex ? service.endpoints[0]! : service.endpoints[random.weighted(service.endpoints.map(candidate => candidate.weight))]!;
    const wayIndex = random.weighted(wayWeights);
    const failed = index !== pathCallIndex && random.next() < 0.04;
    const failure = failed ? failures[random.weighted(failureWeights)] : undefined;
    const { quote, fee } = routingQuote(endpoint.price as MicroUsd, config.routingFeeBps);

    return {
      index, at, serviceIndex, service, endpoint, path: index === pathCallIndex ? veryLongPath : endpoint.path,
      way: wayIndex === wayChains.length ? { kind: 'credits' as const } : { kind: 'chain' as const, chain: chains[wayChains[wayIndex]!] },
      quote: BigInt(quote), fee: BigInt(fee), arrivalMs: random.between(120, 420), latencyMs: failure?.latencyMs ?? latencyOf(random, endpoint),
      status: failure ? failure.status : endpoint.method === 'POST' && random.next() < 0.3 ? 201 : 200, failure,
      freeStatus: random.next() < 0.75 ? 'cancelled' as const : 'failed' as const, withDetails: index >= callsWithoutDetails, paymentId: `pay_${uuidOf(random)}`,
    };
  });

  // Payers: a few buyers with many calls and many days, a tail with one call each
  const payerIndex = new Map<number, number>();
  for (const chain of wayChains) {
    const own = draft.filter(call => call.way.kind === 'chain' && call.way.chain.name === chain);
    for (const call of own)
      payerIndex.set(call.index, random.weighted(payerWeights));
    // Every buyer pays at least once: the first fifty take one call each, and the last ten only that one
    for (const [slot, call] of random.shuffle(own).slice(0, 60).entries())
      payerIndex.set(call.index, slot);
  }
  const accountOf = new Map<number, number>();
  for (const call of draft) {
    if (call.way.kind === 'credits')
      accountOf.set(call.index, random.weighted(accountWeights));
  }

  const calls = draft.map((call): PlannedCall => {
    const account = accountOf.get(call.index);

    return {
      ...call,
      payer: call.way.kind === 'chain' && call.withDetails ? payers[call.way.chain.name][payerIndex.get(call.index)!] : undefined,
      account,
      key: account === undefined ? undefined : random.int(keyCounts[account]!),
    };
  });

  return { calls, payers, merchants, accountCalls: accountWeights.map((_, account) => calls.filter(call => call.account === account)) };
};

// --- Writing ---

const createIds = (): IdGenerator => {
  let counter = 0;

  return { next: () => `${seedLedgerPrefix}${String(++counter).padStart(7, '0')}` };
};

const createKeyRandom = (random: SeededRandom): RandomSource => ({ bytes: size => random.bytes(size) });

const receiptOf = (chain: ChainSetting, network: string, transaction: string, payer: string | undefined, at: Date): string =>
  chain.rail === 'mpp'
    ? Receipt.serialize({ method: 'tempo', status: 'success', timestamp: at.toISOString(), reference: transaction } as never)
    : encodePaymentResponseHeader({ success: true, transaction, network, payer: payer ?? 'unknown' } as never);

const keyLabels = ['research agent', 'trading bot', 'shared key', 'nightly job'] as const;

/** Fills the database, then counts the public numbers once. Wipes the seed's own rows first, so it can run again. */
export const seedLocal = async ({
  postgres, config, now = systemClock.now(), seed = defaultSeed, calls: callCount = defaultCallCount, checkedOnly = false, log = () => undefined,
}: SeedOptions): Promise<SeedSummary> => {
  if (checkedOnly) {
    log('Removing the rows of an earlier seed');
    await wipeSeededRows(postgres.db);
    log('Writing the services a check listed');
    const written = await seedCheckedServices({ postgres, config, now, withPaidHost: false });
    log('Counting the public numbers');
    await countPublicNumbers({ postgres, config });

    return {
      callsByWay: {}, calls: 0, freeCalls: 0, accounts: 0, topups: 0, services: 0, endpoints: 0, ...written, masterKey: '', paymentKey: '',
    };
  }

  const { db } = postgres;
  const random = createSeededRandom(seed);
  const end = new Date(now.getTime() - 5_000);
  const clock = createFakeClock(now);
  const ids = createIds();
  const chains = chainSettings(config);

  log('Removing the rows of an earlier seed');
  await wipeSeededRows(db);

  log('Planning calls');
  const plan = planCalls(random, config, end, callCount);
  const keyRandom = createKeyRandom(random);

  const payments = createPaymentRepository({ db, clock });
  const routing = createRoutingRepository({ db, clock });
  const callRepository = createCallRepository({ db });
  const ledger = createLedger({ db, clock, ids });
  const promo = config.freeCredits.enabled ? config.freeCredits.amount : 0n;

  // --- Accounts: made when their first call or top-up is near, with a master key and payment keys ---
  log('Creating accounts, keys and Credits');
  const accounts: SeedAccount[] = [];
  const topupAt = new Map<number, readonly { readonly usd: number; readonly at: Date; readonly blockchain: string; readonly symbol: string }[]>();
  let firstMaster = '';
  let firstPayment = '';
  const topupChoices = [
    { blockchain: 'base', symbol: 'USDC' }, { blockchain: 'near', symbol: 'USDC' }, { blockchain: 'sol', symbol: 'USDC' }, { blockchain: 'arb', symbol: 'USDC' },
    { blockchain: 'eth', symbol: 'USDC' }, { blockchain: 'base', symbol: 'ETH' },
  ];
  for (const [position, accountCalls] of plan.accountCalls.entries()) {
    const spend = accountCalls.reduce((sum, call) => sum + call.quote, 0n);
    const firstCall = accountCalls[0]?.at ?? end;
    const creditAt = new Date(firstCall.getTime() - random.between(30, 90) * minuteMs);
    const createdAt = new Date(creditAt.getTime() - 12 * minuteMs - random.between(1, 4) * hourMs);
    // Enough for every call of the account, the free Credits counted
    const usd = [1, 2, 5, 10, 20, 50].find(option => creditedFor(option) + promo >= spend * 105n / 100n) ?? 50;
    const choice = random.pick(topupChoices);
    const later = position % 2 === 0 && accountCalls.length > 10
      ? [{ usd: random.pick([5, 10]), at: new Date(firstCall.getTime() + random.int(Math.max(end.getTime() - firstCall.getTime() - hourMs, hourMs))), ...random.pick(topupChoices) }]
      : [];
    topupAt.set(position, [{ usd, at: creditAt, ...choice }, ...later]);

    const id = `acc_${ids.next()}`;
    clock.set(createdAt);
    await createAccountRepository({ db }).create({ id, createdAt });
    const master = generateApiKey('master', config.keyPrefixes, keyRandom);
    await createApiKeyRepository({ db }).insert({ id: `${seedKeyPrefix}${ids.next().slice(5)}`, accountId: id, kind: 'master', keyHash: hashApiKey(master), createdAt });
    const keys: { id: string; dailyBudget: bigint }[] = [];
    for (let slot = 0; slot < keyCounts[position]!; slot++) {
      const key = generateApiKey('payment', config.keyPrefixes, keyRandom);
      const keyId = `${seedKeyPrefix}${ids.next().slice(5)}`;
      const dailyBudget = 5_000_000n;
      await createPaymentKeyRepository({ db }).insert({
        id: keyId, accountId: id, keyHash: hashApiKey(key), label: keyLabels[(position + slot) % keyLabels.length], createdAt, allowance: undefined, dailyBudget,
        maxPrice: undefined, expiresAt: undefined,
      });
      keys.push({ id: keyId, dailyBudget });
      if (position === 0 && slot === 0) {
        firstMaster = master.expose();
        firstPayment = key.expose();
      }
    }
    if (promo > 0n)
      await ledger.promotion({ accountId: id, amount: promo, reference: id, requestId: `${seedRequestPrefix}promo:${id}` });
    accounts.push({ id, createdAt, keys, spend, firstCall });
  }

  // --- The timeline: credited top-ups and calls, in the order they happened ---
  type Event = { readonly at: Date; readonly order: number } & ({ readonly kind: 'call'; readonly call: PlannedCall } | { readonly kind: 'topup'; readonly account: number; readonly spec: { readonly usd: number; readonly at: Date; readonly blockchain: string; readonly symbol: string } });
  const events: Event[] = [
    ...plan.calls.map((call): Event => ({ kind: 'call', at: call.at, order: 1, call })),
    ...[...topupAt.entries()].flatMap(([account, specs]) => specs.map((spec): Event => ({ kind: 'topup', at: spec.at, order: 0, account, spec }))),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order);

  let requestNumber = 0;
  const topupSeeding: TopupSeeding = {
    db, config, clock, ids, random, now,
    requestId: () => `${seedRequestPrefix}topup-request-${++requestNumber}`,
    hash: fakeTransactionHash,
  };
  const firstSeen = new Set<string>();
  // The quiet service's merchant follows the others'
  const merchants = [...plan.merchants, merchantAddress(quietService.paidOn, services.length, random)];
  const quietHostIndex = services.findIndex(service => service.host === quietEndpoint.host);
  let done = 0;
  let topups = 0;

  const runCall = async (call: PlannedCall): Promise<void> => {
    const { service, endpoint, way, failure } = call;
    const requestId = `${seedRequestPrefix}${call.index}`;
    const paid = failure === undefined;
    const buyerChain = way.kind === 'chain' ? way.chain : undefined;
    const legChain = chains[service.paidOn];
    const legHash = fakeTransactionHash(legChain.name, call.index * 3 + 1);
    const buyerHash = buyerChain ? fakeTransactionHash(buyerChain.name, call.index * 5 + 2) : undefined;
    const price = endpoint.price;
    const legAtomic = price;
    const base = {
      id: call.paymentId, requestId, targetHost: service.host, targetPath: call.path, amount: call.quote,
    };

    clock.set(call.at);
    if (way.kind === 'credits') {
      const account = accounts[call.account!]!;
      const key = account.keys[call.key!]!;
      const held = await ledger.hold({
        payment: { ...base, rail: 'credits', buyerAccountId: account.id, keyId: key.id, network: undefined, asset: undefined, atomicAmount: undefined },
        dailyBudget: key.dailyBudget,
        allowance: undefined,
      });
      if (!held.ok)
        throw new Error(`The seed's hold for ${call.paymentId} was refused: ${held.refusal}`);
    }
    else {
      await payments.create({
        ...base, rail: way.chain.rail, buyerAccountId: undefined, keyId: undefined, network: way.chain.asset.network.id, asset: way.chain.asset.name,
        atomicAmount: call.quote, status: 'verified', ...way.chain.rail === 'mpp' ? { transactionHash: buyerHash! } : {},
      });
    }
    if (call.withDetails)
      await callRepository.recordDetails({ paymentId: call.paymentId, method: endpoint.method, payer: call.payer, arrivedAt: new Date(call.at.getTime() - call.arrivalMs) });

    const registered = `${service.host} ${call.path}`;
    const registrable = call.path.length <= 1_000;
    if (registrable && !firstSeen.has(registered)) {
      firstSeen.add(registered);
      await routing.registerEndpoint({ host: service.host, path: call.path, lastPrice: call.quote });
    }

    // Our payment of the API: signed right after the buyer's is accepted
    const signedAt = new Date(call.at.getTime() + 18 + (call.index % 23));
    clock.set(signedAt);
    const hasLeg = failure?.leg !== 'none';
    if (hasLeg) {
      const signatureId = `sig_${ids.next().slice(5)}`;
      await routing.recordSignature({
        id: signatureId, requestId, quoteId: call.paymentId, protocol: legChain.rail, network: legChain.asset.network.id, asset: legChain.asset.name,
        atomicAmount: legAtomic, amount: price, payTo: merchants[call.serviceIndex]!, resource: `https://${service.host}${call.path}`, createdAt: signedAt,
      });
      await routing.recordTargetPayment({
        paymentId: call.paymentId, protocol: legChain.rail, network: legChain.asset.network.id, asset: legChain.asset.name, amount: price, atomicAmount: legAtomic,
        payTo: merchants[call.serviceIndex]!, signatureId,
      });
    }

    // The API answers, and the call ends a few milliseconds after
    const answeredAt = new Date(signedAt.getTime() + call.latencyMs);
    clock.set(new Date(answeredAt.getTime() + 12 + (call.index % 17)));
    await payments.recordDecision({
      paymentId: call.paymentId, decision: paid ? 'billable' : 'not_billable', upstreamStatus: call.status,
      upstreamLatencyMs: failure?.leg === 'none' ? undefined : call.latencyMs,
    });
    if (paid) {
      await routing.updateTargetPayment(call.paymentId, {
        status: 'settled', transactionHash: legHash, receipt: receiptOf(legChain, legChain.asset.network.id, legHash, merchants[call.serviceIndex], answeredAt),
      });
      if (way.kind === 'credits')
        await ledger.capture({ paymentId: call.paymentId });
      else {
        await ledger.settle({
          paymentId: call.paymentId, asset: way.chain.asset.name, transactionHash: buyerHash, receipt: receiptOf(way.chain, way.chain.asset.network.id, buyerHash!, call.payer, answeredAt),
          needsReview: false,
        });
      }

      return;
    }
    if (hasLeg)
      await routing.updateTargetPayment(call.paymentId, { status: failure.leg === 'unknown' ? 'unknown' : 'failed' });
    if (way.kind === 'credits')
      await ledger.release({ paymentId: call.paymentId });
    else
      await payments.changeStatus({ paymentId: call.paymentId, to: call.freeStatus });
  };

  log(`Writing ${plan.calls.length} calls`);
  for (const event of events) {
    if (event.kind === 'topup') {
      await seedTopup(topupSeeding, { account: accounts[event.account]!, ...event.spec, status: 'credited', at: new Date(event.spec.at.getTime() - 7 * minuteMs) });
      topups += 1;
      continue;
    }
    await runCall(event.call);
    done += 1;
    if (done % 500 === 0)
      log(`  ${done} calls`);
  }

  // --- The other states a top-up has ---
  log('Writing top-ups in every state');
  const states: readonly { readonly status: TopupStatus; readonly blockchain: string; readonly symbol: string; readonly usd: number; readonly agoMinutes: number }[] = [
    { status: 'waiting', blockchain: 'base', symbol: 'USDC', usd: 5, agoMinutes: 40 },
    { status: 'waiting', blockchain: 'sol', symbol: 'SOL', usd: 12, agoMinutes: 3 * 60 },
    { status: 'incomplete', blockchain: 'arb', symbol: 'USDC', usd: 10, agoMinutes: 90 },
    { status: 'processing', blockchain: 'eth', symbol: 'USDC', usd: 25, agoMinutes: 8 },
    { status: 'refunded', blockchain: 'near', symbol: 'wNEAR', usd: 3, agoMinutes: 2 * 24 * 60 },
    { status: 'failed', blockchain: 'btc', symbol: 'BTC', usd: 30, agoMinutes: 5 * 24 * 60 },
    { status: 'expired', blockchain: 'base', symbol: 'ETH', usd: 2, agoMinutes: 3 * 24 * 60 },
    { status: 'quote_failed', blockchain: 'eth', symbol: 'USDC', usd: 0.2, agoMinutes: 6 * 60 },
    { status: 'quote_unknown', blockchain: 'sol', symbol: 'USDC', usd: 4, agoMinutes: 26 * 60 },
    { status: 'quoting', blockchain: 'near', symbol: 'USDC', usd: 6, agoMinutes: 0.2 },
  ];
  for (const [index, state] of states.entries()) {
    await seedTopup(topupSeeding, { account: accounts[index % accounts.length]!, ...state, at: new Date(now.getTime() - state.agoMinutes * minuteMs) });
    topups += 1;
  }

  // The calls 40 days old: a paid service and a paid endpoint with no call in the last 30 days
  log('Writing the paid service and the paid endpoint with no call in 30 days');
  const quietCalls = [
    { service: quietService, serviceIndex: services.length, endpoint: quietService.endpoints[0]! },
    { service: quietService, serviceIndex: services.length, endpoint: quietService.endpoints[1]! },
    { service: services[quietHostIndex]!, serviceIndex: quietHostIndex, endpoint: quietEndpoint.endpoint },
  ];
  for (const [position, quiet] of quietCalls.entries()) {
    const { quote, fee } = routingQuote(quiet.endpoint.price as MicroUsd, config.routingFeeBps);
    await runCall({
      index: plan.calls.length + position, at: new Date(now.getTime() - quietAgoMs - position * hourMs), paymentId: `pay_${uuidOf(random)}`, ...quiet, path: quiet.endpoint.path,
      way: { kind: 'chain', chain: chains.base }, payer: `0x${'ab'.repeat(20)}`, account: undefined, key: undefined, quote: BigInt(quote), fee: BigInt(fee),
      arrivalMs: 200, latencyMs: 180, status: 200, failure: undefined, freeStatus: 'cancelled', withDetails: true,
    });
  }

  log('Writing the services a check listed');
  const written = await seedCheckedServices({ postgres, config, now, withPaidHost: true });

  log('Counting the public numbers');
  await countPublicNumbers({ postgres, config });

  const summary = await summarize(postgres);

  return { ...summary, ...written, accounts: accounts.length, topups, masterKey: firstMaster, paymentKey: firstPayment };
};

/**
 * Lists the services a check lists, through the routing repository's registration, as a real check does: its method,
 * its time, the last quote. A fake clock gives each its time. With `withPaidHost`, two more on a host the calls reached.
 */
const seedCheckedServices = async ({ postgres, config, now, withPaidHost }: {
  readonly postgres: Postgres;
  readonly config: PlatformConfig;
  readonly now: Date;
  readonly withPaidHost: boolean;
}): Promise<Pick<SeedSummary, 'checkedServices' | 'checkedEndpoints'>> => {
  const clock = createFakeClock(now);
  const routing = createRoutingRepository({ db: postgres.db, clock });
  const definitions = withPaidHost ? [...checkedServices, checkedOnPaidHost] : checkedServices;
  let endpoints = 0;
  for (const definition of definitions) {
    for (const endpoint of definition.endpoints) {
      clock.set(new Date(now.getTime() - endpoint.checkedAgoMs));
      const registered = await routing.registerEndpoint({
        host: definition.host, path: endpoint.path, lastPrice: BigInt(routingQuote(endpoint.price as MicroUsd, config.routingFeeBps).quote),
        checked: { method: endpoint.method, mayAddHost: true },
      });
      if (registered !== 'created')
        throw new Error(`The seed's checked endpoint ${definition.host}${endpoint.path} was not listed: ${registered}`);
      endpoints += 1;
    }
  }

  return { checkedServices: checkedServices.length, checkedEndpoints: endpoints };
};

/** Runs the workers' two counts of the public numbers once, so the pages have numbers at once. */
export const countPublicNumbers = async ({ postgres, config }: { readonly postgres: Postgres; readonly config: PlatformConfig }): Promise<void> => {
  const options = {
    counter: createStatsCounter({ db: postgres.db, ways: createPaidWith(config).ways }),
    store: createStatsRepository({ db: postgres.db }),
    config,
    metrics: { counted: () => undefined },
    clock: systemClock,
  };
  await createRecentStats(options)();
  await createAllStats(options)();
};

/** Removes everything the seed wrote, and counts the public numbers again, so they are empty. */
export const emptyLocal = async ({ postgres, config }: { readonly postgres: Postgres; readonly config: PlatformConfig }): Promise<void> => {
  await wipeSeededRows(postgres.db);
  await countPublicNumbers({ postgres, config });
};

const summarize = async (postgres: Postgres): Promise<Pick<SeedSummary, 'callsByWay' | 'calls' | 'freeCalls' | 'services' | 'endpoints'>> => {
  const { rows: byWay } = await postgres.db.execute<{ way: string; calls: number }>(sql`
    select (case when rail = 'credits' then 'credits' else rail || ' ' || network end) as way, count(*)::int as calls
    from payments where request_id like ${`${seedRequestPrefix}%`} group by 1 order by 2 desc`);
  const { rows: [totals] } = await postgres.db.execute<{ calls: number; free: number; services: number; endpoints: number }>(sql`
    select count(*)::int as calls, (count(*) filter (where status in ('released', 'cancelled', 'failed')))::int as free,
      count(distinct target_host)::int as services, count(distinct target_host || ' ' || target_path)::int as endpoints
    from payments where request_id like ${`${seedRequestPrefix}%`}`);

  return {
    callsByWay: Object.fromEntries(byWay.map(row => [row.way, row.calls])),
    calls: totals?.calls ?? 0,
    freeCalls: totals?.free ?? 0,
    services: totals?.services ?? 0,
    endpoints: totals?.endpoints ?? 0,
  };
};
