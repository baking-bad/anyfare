import { AsyncLocalStorage } from 'node:async_hooks';

import { Counter, Gauge, Histogram } from '@prometheus-io/client';
import { x402Facilitator } from '@x402/core/facilitator';
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types';
import { NEAR_RPC_URLS, settlementCacheKey } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/facilitator';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

import {
  AnyfareError, createServer, redactedMessage, Secret, systemClock, type Clock, type ErrorStatusTable, type Logger, type Server,
} from '@anyfare/common';
import type { NetworkInfo, PlatformConfig } from '@anyfare/core';

import { createOutcomeMemory, requirementOf, type FinalOutcome, type RememberedSettle } from './outcomes.js';
import { createRelayer, minimumRelayerBalance, type RelayerFlight, type RelayerState, type SignedRelayerTransaction } from './relayer.js';

// The shared secret every call but health, readiness, and metrics carries
export const apiKeyHeader = 'x-api-key';
// The largest verify or settle body: a NEAR payment and its requirement take a few KiB
export const maxBodyBytes = 64 * 1024;
// Our own refusal: the payment isn't to one of our accounts in our token on our network
export const notOursReason = 'recipient_not_ours';
// The most settles waiting for the relayer, the running one included. Another is refused with a 503.
export const maxSettleQueueDepth = 32;
// The x402 answer for a transaction sent and not final yet
export const settlementPendingReason = 'settlement_pending';
// How long before the caller's settle timeout a settle answers, and the least it waits
const answerMarginMs = 5_000;
const minimumAnswerMs = 5_000;
// At most one warning a minute about the relayer's balance
const balanceWarningMs = 60_000;

/** The relayer: the account that submits the buyers' signed delegate actions and pays their gas. */
export interface RelayerAccount {
  readonly accountId: string;
  // Its full-access key, `ed25519:` and base58
  readonly secretKey: Secret;
}

export interface FacilitatorDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  // FACILITATOR_SECRET, which callers send in X-API-Key. Without it, every call is refused.
  readonly secret: Secret | undefined;
  readonly relayer: RelayerAccount;
  // Our accounts. A payment to any other is refused before any RPC call.
  readonly recipients: readonly string[];
  // The NEAR RPC by network. Default: the SDK's public RPC of the network.
  readonly rpcUrls?: Readonly<Partial<Record<string, string>>>;
  // The most gas a delegate action may have the relayer sponsor. Default: the SDK's, 100 TGas.
  readonly maxSponsoredGas?: bigint;
  // For how long settles are remembered
  readonly clock?: Clock;
  // How often the relayer polls a transaction whose send had no answer. Default: a second.
  readonly pollMs?: number;
}

/** What the facilitator serves, from the platform config's NEAR assets. */
export interface NearSetup {
  readonly network: NetworkInfo;
  // The token contracts of the NEAR assets, such as USDC's
  readonly assets: readonly string[];
  // Their payTo: our accounts that receive them
  readonly payTo: readonly string[];
}

/** The NEAR network of the platform config's NEAR assets, with their contracts. Throws unless they are on exactly one network. */
export const nearSetupOf = (config: Pick<PlatformConfig, 'assets'>): NearSetup => {
  const assets = config.assets.filter(asset => asset.network.namespace === 'near');
  const networks = [...new Map(assets.map(asset => [asset.network.id, asset.network])).values()];
  const [network] = networks;
  if (!network || networks.length > 1)
    throw new Error(`The facilitator needs the platform config's NEAR assets on exactly one network, not ${networks.length}`);

  return {
    network,
    assets: assets.map(asset => asset.address),
    payTo: [...new Set(assets.flatMap(asset => asset.payTo === undefined ? [] : [asset.payTo]))],
  };
};

/** The RPC the facilitator uses on a network: the override, else the SDK's public one. */
export const nearRpcUrlOf = (network: string, rpcUrls: Readonly<Partial<Record<string, string>>> = {}): string => {
  const url = rpcUrls[network] ?? (NEAR_RPC_URLS as Readonly<Record<string, string>>)[network];
  if (url === undefined)
    throw new Error(`The x402 SDK has no NEAR RPC for ${network}`);

  return url;
};

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  }
  catch {
    return 'an RPC';
  }
};

/** What's wrong with the relayer on chain, for readiness and the startup check, or undefined. */
export const relayerProblem = (state: RelayerState, accountId: string): string | undefined => {
  if (state.amount === undefined)
    return `The relayer account ${accountId} doesn't exist`;
  if (state.key === undefined)
    return `FACILITATOR_NEAR_KEY isn't an access key of ${accountId}`;
  if (state.key !== 'FullAccess')
    return `FACILITATOR_NEAR_KEY isn't a full-access key of ${accountId}`;

  return undefined;
};

/** NEAR from yoctoNEAR, for a gauge or a line. */
export const nearOf = (amount: bigint): number => Number(amount / 10n ** 18n) / 1_000_000;

class UnauthorizedError extends AnyfareError {
  readonly code = 'unauthorized';
}

// The SDK threw. The caller gets a fixed message; the log gets `reason`, the SDK's message without URLs.
class FacilitatorFailedError extends AnyfareError {
  readonly code = 'facilitator_failed';

  constructor(readonly reason: string) {
    super('The facilitator failed');
  }
}

// Too many settles wait for the relayer, or this one's turn hasn't come before it had to answer: nothing was sent
class FacilitatorBusyError extends AnyfareError {
  readonly code = 'facilitator_busy';

  constructor() {
    super('The relayer is busy: settle again later');
  }
}

// The scheme couldn't read the chain: no answer about the payment
class RpcUnavailableError extends AnyfareError {
  readonly code = 'facilitator_rpc_unavailable';

  constructor(readonly reason: string) {
    super('The NEAR RPC is unavailable: try again later');
  }
}

const errorStatuses = {
  unauthorized: 401, facilitator_busy: 503, facilitator_rpc_unavailable: 503, facilitator_failed: 500,
} as const satisfies ErrorStatusTable;

// The scheme's reasons that say the RPC didn't answer, not that the payment is wrong
const transientReasons: ReadonlySet<string> = new Set([
  'invalid_exact_near_current_block_height_unavailable', 'invalid_exact_near_access_key_lookup_failed', 'invalid_exact_near_account_lookup_failed',
  'invalid_exact_near_token_account_lookup_failed', 'invalid_exact_near_balance_check_failed', 'invalid_exact_near_storage_check_failed',
  'unexpected_verify_error',
]);

// The reasons the SDK's NEAR scheme answers with (@x402/near 2.30.0), and ours: the metrics' bounded labels
const knownReasons: ReadonlySet<string> = new Set([
  notOursReason, 'duplicate_settlement', 'insufficient_funds', 'invalid_network', 'invalid_x402_version', 'settlement_failed', 'unexpected_verify_error',
  'unsupported_scheme', 'verification_failed',
  ...[
    'access_key_lookup_failed', 'access_key_not_found', 'account_lookup_failed', 'amount_mismatch', 'asset_mismatch', 'balance_check_failed',
    'current_block_height_unavailable', 'function_call_key_not_allowed', 'max_timeout', 'network_mismatch', 'no_relayer_configured', 'pay_to_mismatch',
    'payload_action_count', 'payload_action_kind', 'payload_amount_mismatch', 'payload_attached_deposit', 'payload_delegate_action_expired',
    'payload_delegate_action_nonce_already_used', 'payload_delegate_action_nonce_out_of_range', 'payload_delegate_action_timeout_window_exceeds_max_timeout',
    'payload_ft_transfer_args', 'payload_gas_limit_exceeded', 'payload_method_name', 'payload_recipient_mismatch', 'payload_shape', 'payload_signature',
    'payload_signed_delegate_action', 'payload_token_contract_mismatch', 'recipient_not_registered_for_storage', 'relayer_cannot_be_payer',
    'sender_account_not_found', 'storage_check_failed', 'token_account_lookup_failed', 'token_account_not_found', 'token_contract_no_code',
    'unsupported_access_key_permission',
  ].map(reason => `invalid_exact_near_${reason}`),
]);

const reasonLabel = (reason: string | undefined): string => reason !== undefined && knownReasons.has(reason) ? reason : 'other';

// The x402 v2 requirement, as the resource server sends it
const requirementSchema = {
  type: 'object',
  required: ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds'],
  properties: {
    scheme: { type: 'string', minLength: 1, maxLength: 64 },
    network: { type: 'string', minLength: 1, maxLength: 128 },
    asset: { type: 'string', minLength: 1, maxLength: 128 },
    amount: { type: 'string', pattern: '^[0-9]{1,40}$' },
    payTo: { type: 'string', minLength: 1, maxLength: 128 },
    maxTimeoutSeconds: { type: 'integer', minimum: 1, maximum: 86_400 },
    extra: { type: 'object' },
  },
  additionalProperties: false,
} as const;

// The buyer's x402 v2 payment on NEAR: a base64 Borsh signed delegate action
const payloadSchema = {
  type: 'object',
  required: ['x402Version', 'accepted', 'payload'],
  properties: {
    x402Version: { type: 'integer', enum: [2] },
    resource: { type: 'object' },
    accepted: requirementSchema,
    payload: {
      type: 'object',
      required: ['signedDelegateAction'],
      properties: { signedDelegateAction: { type: 'string', minLength: 1, maxLength: 16_384 } },
      additionalProperties: false,
    },
    extensions: { type: 'object' },
  },
  additionalProperties: false,
} as const;

// What the x402 SDK's HTTP facilitator client sends to /verify and /settle
const bodySchema = {
  type: 'object',
  required: ['x402Version', 'paymentPayload', 'paymentRequirements'],
  properties: {
    x402Version: { type: 'integer', enum: [2] },
    paymentPayload: payloadSchema,
    paymentRequirements: requirementSchema,
  },
  additionalProperties: false,
} as const;

interface FacilitatorBody {
  readonly x402Version: number;
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
}

const maxMessageLength = 500;
const urlPattern = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** A message without URLs, which may carry an RPC's key, nor any part of `secrets`, and short. */
const scrubber = (secrets: readonly string[]) => (text: string): string => {
  let clean = text.replace(urlPattern, hostOf);
  for (const secret of secrets)
    clean = clean.split(secret).join(redactedMessage);

  return clean.length > maxMessageLength ? `${clean.slice(0, maxMessageLength)}…` : clean;
};

interface SettleQueue {
  // The settles waiting, the running one included
  readonly depth: number;
  /** Runs `task` once every settle queued before it has finished. */
  run<TResult>(task: () => Promise<TResult>): Promise<TResult>;
}

/** One relayer's settles, one at a time, in the order they came. */
const createSettleQueue = (onDepth: (depth: number) => void): SettleQueue => {
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;

  return {
    get depth() {
      return depth;
    },
    run: task => {
      depth += 1;
      onDepth(depth);
      const result = tail.then(task);
      tail = result.then(() => undefined, () => undefined);

      return result.finally(() => {
        depth -= 1;
        onDepth(depth);
      });
    },
  };
};

/** The task's result, or undefined when `ms` pass first. The task goes on either way. */
const untilDeadline = <TResult>(task: Promise<TResult>, ms: number): Promise<TResult | undefined> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  task.then(value => {
    clearTimeout(timer);
    resolve(value);
  }, (error: unknown) => {
    clearTimeout(timer);
    reject(error);
  });
});

/** Readiness: the RPC answers `block`. Our own call, with the check's deadline. Its errors name the host only. */
const checkRpc = async (url: string, signal: AbortSignal): Promise<void> => {
  const host = hostOf(url);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ready', method: 'block', params: { finality: 'final' } }),
      redirect: 'error',
      signal,
    });
    text = await response.text();
  }
  catch {
    throw new Error(`The NEAR RPC at ${host} didn't answer block`);
  }
  let height: unknown;
  try {
    height = (JSON.parse(text) as { result?: { header?: { height?: unknown } } }).result?.header?.height;
  }
  catch {
    height = undefined;
  }
  if (response.status !== 200 || typeof height !== 'number')
    throw new Error(`The NEAR RPC at ${host} answered block with ${response.status} and no block`);
};

// One settle through the relayer: what the route and the relayer tell each other
interface Flight extends RelayerFlight {
  readonly settlementKey: string;
  // The requirement it's settled for, as `requirementOf` writes it
  readonly requirement: string;
  cancelled: boolean;
  // Once signed
  transaction?: string;
  payer?: string;
  abandon?: 'refused' | 'unavailable' | 'stopped';
  // Ends when the relayer's first send is over
  readonly sendPhase: Promise<void>;
}

const createFlight = (settlementKey: string, requirement: string, onSigned: (flight: Flight, signed: SignedRelayerTransaction) => void): Flight => {
  let endSendPhase: () => void = () => undefined;
  const sendPhase = new Promise<void>(resolve => {
    endSendPhase = resolve;
  });
  const flight: Flight = {
    settlementKey, requirement, cancelled: false, sendPhase,
    signed: signed => {
      flight.transaction = signed.transaction;
      flight.payer = signed.payer;
      onSigned(flight, signed);
    },
    sendPhaseOver: () => endSendPhase(),
    abandoned: reason => {
      flight.abandon = reason;
    },
  };

  return flight;
};

/**
 * How a settle ended: settled or failed (both remembered once signed), remembered, cancelled (never
 * signed), refused or unavailable (no outcome of the payment: forgotten), or stopped by a shutdown.
 */
type SettlePath = 'settled' | 'failed' | 'remembered' | 'cancelled' | 'refused' | 'unavailable' | 'stopped';

interface SettleTurn {
  readonly path: SettlePath;
  readonly answer: SettleResponse;
}

/**
 * Our x402 facilitator for NEAR, on the internal network: the x402 SDK's facilitator with the
 * official `exact` scheme on the platform config's NEAR network, over our own relayer (see
 * `createRelayer`), which submits each buyer's signed delegate action and pays its gas.
 * - `GET /supported`, `POST /verify`, `POST /settle` as the x402 facilitator API, each with the shared
 *   secret in X-API-Key, compared timing-safe.
 * - Before the scheme sees a payment, our own check: the requirement and the payment's `accepted`
 *   are both the `exact` scheme on our network, in our token, to one of our recipients. Otherwise
 *   `recipient_not_ours`, without any RPC call.
 * - A scheme answer that says the RPC didn't answer is a 503 `facilitator_rpc_unavailable`, not a
 *   verdict on the payment.
 * - Settles take the relayer one at a time, through the SDK's verify, the signing, and the first
 *   send: the SDK reads the relayer's nonce and sends in one step, so two at once would take the same
 *   nonce. A transaction whose first send had no answer is polled outside that turn. More than
 *   `maxSettleQueueDepth` waiting are refused with a 503. Verifies run concurrently.
 * - A settle answers by `timeouts.settleMs` less 5 s, and at least 5 s, from when it was asked. Not
 *   ended then, it answers `settlement_pending` with the hash once its transaction is signed, and goes
 *   on. Not signed then, it's cancelled and answers a 503 `facilitator_busy`: it never sends.
 * - The outcome of each settle whose transaction was signed is remembered by its settlement key: a
 *   settle of the same payment answers it without verifying again. A refusal of our transaction by
 *   the node isn't remembered: answered before any pending answer, it's a failed settlement; after
 *   one, the settle is forgotten, so the follow-up's repeat verifies and signs afresh.
 * - Readiness: the RPC answers `block`, and the relayer's key is a full-access key of its account.
 */
export const createApp = ({
  config, logger, secret, relayer: account, recipients, rpcUrls, maxSponsoredGas, clock = systemClock, pollMs,
}: FacilitatorDependencies): Server => {
  const { network, assets } = nearSetupOf(config);
  const rpcUrl = nearRpcUrlOf(network.id, rpcUrls);
  const ours = new Set(recipients);
  const key = account.secretKey.expose();
  const scrub = scrubber([key, key.slice(key.indexOf(':') + 1)].filter(part => part.length >= 16));
  const memory = createOutcomeMemory({ clock });
  const flights = new AsyncLocalStorage<Flight>();
  const relayer = createRelayer({
    accountId: account.accountId, secretKey: account.secretKey, network: network.id, rpcUrl, readMs: config.timeouts.connectMs, sendMs: config.timeouts.connectMs,
    ...pollMs === undefined ? {} : { pollMs },
    onHeight: height => memory.observeHeight(height),
    flight: () => flights.getStore(),
  });
  // From when it's signed, a settle's transaction is remembered as pending
  const onSigned = (flight: Flight, signed: SignedRelayerTransaction): void => memory.pending(signed.key, {
    transaction: signed.transaction, payer: signed.payer, network: network.id, requirement: flight.requirement, maxBlockHeight: signed.maxBlockHeight,
  });
  // The settles not ended yet, for a shutdown
  const live = new Set<Flight>();
  let closing = false;
  const facilitator = new x402Facilitator()
    .register(network.id as Network, new ExactNearScheme(relayer, undefined, maxSponsoredGas === undefined ? undefined : { maxSponsoredGas }));
  const answerMs = Math.max(config.timeouts.settleMs - answerMarginMs, minimumAnswerMs);

  let lastBalanceWarning = Number.NEGATIVE_INFINITY;
  // Readiness: the relayer's key is a full-access key of its account, and its NEAR goes to the gauge
  const checkRelayer = async (): Promise<void> => {
    let state: RelayerState;
    try {
      state = await relayer.state();
    }
    catch {
      throw new Error(`The NEAR RPC at ${hostOf(rpcUrl)} didn't answer for the relayer`);
    }
    if (state.amount !== undefined) {
      balance.set(nearOf(state.amount));
      if (state.amount < minimumRelayerBalance && performance.now() - lastBalanceWarning >= balanceWarningMs) {
        lastBalanceWarning = performance.now();
        logger.warn({ relayer: account.accountId, balance: nearOf(state.amount) }, 'The relayer holds under 0.05 NEAR: its transactions may not pay their gas');
      }
    }
    const problem = relayerProblem(state, account.accountId);
    if (problem)
      throw new Error(problem);
  };

  const server = createServer({
    logger,
    errorStatuses,
    bodyLimit: maxBodyBytes,
    readinessChecks: [
      { name: 'near-rpc', check: signal => checkRpc(rpcUrl, signal) },
      { name: 'near-relayer', check: checkRelayer },
    ],
  });
  const verifies = new Counter({
    name: 'facilitator_verifies_total',
    help: 'Verify requests answered, by result: valid, the reason it is not, rpc_unavailable (a 503), or error',
    labelNames: ['result'] as const,
    registers: [server.metrics.registry],
  });
  const settles = new Counter({
    name: 'facilitator_settles_total',
    help: 'Settle requests answered, by result: settled, pending, remembered, the reason it failed, busy or rpc_unavailable (a 503), or error',
    labelNames: ['result'] as const,
    registers: [server.metrics.registry],
  });
  const settleDuration = new Histogram({
    name: 'facilitator_settle_duration_seconds',
    help: 'How long a settle took to answer, its wait for the relayer included, by outcome: settled, failed, pending, busy, or rpc_unavailable',
    labelNames: ['outcome'] as const,
    buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 34],
    registers: [server.metrics.registry],
  });
  const queueDepth = new Gauge({
    name: 'facilitator_settle_queue_depth',
    help: 'Settles waiting for the relayer, the running one included',
    registers: [server.metrics.registry],
  });
  const balance = new Gauge({
    name: 'facilitator_relayer_balance_near',
    help: 'The relayer\'s NEAR, as the last readiness probe read it',
    registers: [server.metrics.registry],
  });
  // One relayer, so one queue
  const settleQueue = createSettleQueue(depth => queueDepth.set(depth));

  // The shared secret, compared with `Secret.equals`, which is timing-safe
  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const header = request.headers[apiKeyHeader];
    const given = typeof header === 'string' && header !== '' ? Secret.from(header) : undefined;
    try {
      if (secret && given?.equals(secret))
        return;
    }
    finally {
      given?.destroy();
    }
    throw new UnauthorizedError('The facilitator needs the X-API-Key header');
  };

  const isOursOption = (option: PaymentRequirements): boolean =>
    option.network === network.id && option.scheme === 'exact' && assets.includes(option.asset) && ours.has(option.payTo);
  // The scheme compares the rest of `accepted` with the requirement itself
  const isOurs = (payload: PaymentPayload, requirements: PaymentRequirements): boolean => isOursOption(requirements) && isOursOption(payload.accepted);

  // What a payment asks, for its line: never the payload
  const askedOf = (requirements: PaymentRequirements) => ({ network: requirements.network, payTo: requirements.payTo, amount: requirements.amount });

  const failed = (error: unknown): FacilitatorFailedError =>
    new FacilitatorFailedError(scrub(error instanceof Error ? `${error.name}: ${error.message}` : 'A thrown value that isn\'t an Error'));

  const answerOf = ({ outcome, payer, network: on }: RememberedSettle): SettleResponse => {
    const base = { network: on as Network, payer };
    switch (outcome.state) {
      case 'settled':
        return { success: true, transaction: outcome.transaction, ...base };
      case 'pending':
        return { success: false, errorReason: settlementPendingReason, transaction: outcome.transaction, ...base };
      case 'failed':
        return {
          success: false, errorReason: outcome.reason, ...outcome.message === undefined ? {} : { errorMessage: outcome.message }, transaction: outcome.transaction, ...base,
        };
    }
  };

  // A settle of the same payment for the same requirement that we signed a transaction for
  const recall = (settlementKey: string, requirement: string): SettleResponse | undefined => {
    const remembered = memory.get(settlementKey);

    return remembered?.requirement === requirement ? answerOf(remembered) : undefined;
  };

  // How a settle the SDK ended: remembered when it's an outcome of the payment, forgotten when it isn't
  const finish = (flight: Flight, raw: SettleResponse): SettleTurn => {
    live.delete(flight);
    flight.sendPhaseOver();
    let answer = raw.errorMessage === undefined ? raw : { ...raw, errorMessage: scrub(raw.errorMessage) };
    // A failure after we signed names our transaction, as the SDK leaves it out when the send threw. A
    // caller that holds a pending answer for it then knows that transaction failed.
    if (!answer.success && answer.transaction === '' && flight.transaction !== undefined)
      answer = { ...answer, transaction: flight.transaction };
    if (flight.abandon === 'refused' || flight.abandon === 'unavailable') {
      memory.forget(flight.settlementKey);
      return { path: flight.abandon, answer };
    }
    if (flight.abandon === 'stopped') {
      if (flight.transaction !== undefined)
        logger.warn({ payer: flight.payer ?? null, transaction: flight.transaction }, 'A relayer transaction was in flight at shutdown');
      return { path: 'stopped', answer };
    }
    if (flight.cancelled && flight.transaction === undefined)
      return { path: 'cancelled', answer };
    if (flight.transaction !== undefined) {
      const outcome: FinalOutcome = answer.success
        ? { state: 'settled', transaction: answer.transaction }
        : { state: 'failed', reason: answer.errorReason ?? 'settlement_failed', message: answer.errorMessage, transaction: answer.transaction };
      memory.finish(flight.settlementKey, outcome);
    }

    return { path: answer.success ? 'settled' : 'failed', answer };
  };

  const placeholder = (path: 'cancelled' | 'remembered', answer?: SettleResponse): SettleTurn =>
    ({ path, answer: answer ?? { success: false, errorReason: path, transaction: '', network: network.id as Network } });

  /**
   * A settle's turn with the relayer: the SDK's verify, the signing, and the first send. The queue
   * moves on once that's over; the settle's end comes after, when its transaction is known.
   */
  const beginSettle = async (flight: Flight, payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ readonly ended: Promise<SettleTurn> }> => {
    if (flight.cancelled || closing) {
      live.delete(flight);
      flight.cancelled = true;
      return { ended: Promise.resolve(placeholder('cancelled')) };
    }
    // A settle of the same payment that ended, or is in flight, since this one was asked
    const known = recall(flight.settlementKey, flight.requirement);
    if (known) {
      live.delete(flight);
      return { ended: Promise.resolve(placeholder('remembered', known)) };
    }
    const ended = flights.run(flight, () => facilitator.settle(payload, requirements)).then(raw => finish(flight, raw), (error: unknown) => {
      live.delete(flight);
      flight.sendPhaseOver();
      throw error;
    });
    await Promise.race([ended.then(() => undefined, () => undefined), flight.sendPhase]);

    return { ended };
  };

  // The line of a settle's answer
  const logSettle = (log: FastifyBaseLogger, asked: ReturnType<typeof askedOf>, { path, answer }: SettleTurn, durationMs: number | undefined, msg?: string): void => {
    const line = {
      ...asked, payer: answer.payer ?? null, result: path, transaction: answer.transaction || null,
      ...answer.success ? {} : { reason: answer.errorReason ?? null, ...answer.errorMessage === undefined ? {} : { message: answer.errorMessage } },
      ...durationMs === undefined ? {} : { durationMs: Math.round(durationMs) },
    };
    if (path === 'failed')
      log.warn(line, msg ?? 'A settlement failed');
    else
      log.info(line, msg ?? (path === 'settled' ? 'Settled a payment' : 'Answered a settle from the outcome remembered for it'));
  };

  // The line of a settle that had answered pending, when it ends
  const logLate = (log: FastifyBaseLogger, asked: ReturnType<typeof askedOf>, turn: SettleTurn, started: number): void => {
    if (turn.path === 'settled' || turn.path === 'failed')
      logSettle(log, asked, turn, performance.now() - started, 'A settle that had answered became final');
    else if (turn.path === 'refused' || turn.path === 'unavailable') {
      log.warn({ ...asked, result: turn.path, transaction: turn.answer.transaction || null, ...turn.answer.errorMessage === undefined ? {} : { message: turn.answer.errorMessage } },
        'A settle that had answered pending ended without an outcome: forgotten, its repeat settles afresh');
    }
  };

  const pendingOf = (flight: Flight): SettleResponse => ({
    success: false, errorReason: settlementPendingReason, transaction: flight.transaction ?? '', network: network.id as Network,
    ...flight.payer === undefined ? {} : { payer: flight.payer },
  });

  server.app.get('/supported', { onRequest: authenticate }, async () => facilitator.getSupported());

  server.app.post<{ Body: FacilitatorBody }>('/verify', { onRequest: authenticate, schema: { body: bodySchema } }, async request => {
    const { paymentPayload, paymentRequirements } = request.body;
    const asked = askedOf(paymentRequirements);
    if (!isOurs(paymentPayload, paymentRequirements)) {
      verifies.inc({ result: notOursReason });
      request.log.info({ ...asked, scheme: paymentRequirements.scheme, asset: paymentRequirements.asset, result: 'refused', reason: notOursReason },
        'Refused to verify a payment that isn\'t to us');

      return { isValid: false, invalidReason: notOursReason } satisfies VerifyResponse;
    }
    const started = performance.now();
    let answer: VerifyResponse;
    try {
      answer = await facilitator.verify(paymentPayload, paymentRequirements);
    }
    catch (error) {
      verifies.inc({ result: 'error' });
      throw failed(error);
    }
    if (answer.invalidMessage !== undefined)
      answer = { ...answer, invalidMessage: scrub(answer.invalidMessage) };
    const line = { ...asked, payer: answer.payer ?? null, durationMs: Math.round(performance.now() - started) };
    if (!answer.isValid && transientReasons.has(answer.invalidReason ?? '')) {
      verifies.inc({ result: 'rpc_unavailable' });
      request.log.warn({ ...line, result: 'rpc_unavailable', reason: answer.invalidReason, ...answer.invalidMessage === undefined ? {} : { message: answer.invalidMessage } },
        'Couldn\'t verify a payment: the NEAR RPC didn\'t answer');
      throw new RpcUnavailableError(answer.invalidReason ?? 'unknown');
    }
    verifies.inc({ result: answer.isValid ? 'valid' : reasonLabel(answer.invalidReason) });
    if (answer.isValid)
      request.log.info({ ...line, result: 'valid' }, 'Verified a payment');
    else {
      request.log.info({
        ...line, result: 'invalid', reason: answer.invalidReason ?? null, ...answer.invalidMessage === undefined ? {} : { message: answer.invalidMessage },
      }, 'A payment failed verification');
    }

    return answer;
  });

  server.app.post<{ Body: FacilitatorBody }>('/settle', { onRequest: authenticate, schema: { body: bodySchema } }, async request => {
    const { paymentPayload, paymentRequirements } = request.body;
    const asked = askedOf(paymentRequirements);
    if (!isOurs(paymentPayload, paymentRequirements)) {
      settles.inc({ result: notOursReason });
      request.log.info({ ...asked, scheme: paymentRequirements.scheme, asset: paymentRequirements.asset, result: 'refused', reason: notOursReason },
        'Refused to settle a payment that isn\'t to us');

      return { success: false, errorReason: notOursReason, transaction: '', network: paymentRequirements.network as Network } satisfies SettleResponse;
    }
    const started = performance.now();
    const observe = (outcome: string) => settleDuration.observe({ outcome }, (performance.now() - started) / 1_000);
    const settlementKey = settlementCacheKey(String(paymentPayload.payload['signedDelegateAction']));
    const known = recall(settlementKey, requirementOf(paymentRequirements));
    if (known) {
      settles.inc({ result: 'remembered' });
      logSettle(request.log, asked, { path: 'remembered', answer: known }, undefined);

      return known;
    }
    if (closing || settleQueue.depth >= maxSettleQueueDepth) {
      settles.inc({ result: 'busy' });
      observe('busy');
      throw new FacilitatorBusyError();
    }
    const flight = createFlight(settlementKey, requirementOf(paymentRequirements), onSigned);
    live.add(flight);
    const ended = settleQueue.run(() => beginSettle(flight, paymentPayload, paymentRequirements)).then(begun => begun.ended);
    let turn: SettleTurn | undefined;
    try {
      turn = await untilDeadline(ended, answerMs - (performance.now() - started));
    }
    catch (error) {
      settles.inc({ result: 'error' });
      throw failed(error);
    }

    if (!turn) {
      if (flight.transaction === undefined) {
        // Never signed, and now never will be: the relayer checks this right before it signs
        flight.cancelled = true;
        settles.inc({ result: 'busy' });
        observe('busy');
        request.log.warn({ ...asked, result: 'busy' }, 'A settle didn\'t reach the relayer in time: nothing was sent');
        throw new FacilitatorBusyError();
      }
      // It goes on, and its outcome is remembered
      ended.then(late => logLate(request.log, asked, late, started), (error: unknown) => request.log.error({ error: failed(error) }, 'A settle that had answered failed'));
      settles.inc({ result: 'pending' });
      observe('pending');
      request.log.info({ ...asked, payer: flight.payer ?? null, result: 'pending', transaction: flight.transaction, durationMs: Math.round(performance.now() - started) },
        'A settlement is pending: the relayer\'s transaction isn\'t final yet');

      return pendingOf(flight);
    }

    const { path, answer } = turn;
    switch (path) {
      case 'remembered':
        settles.inc({ result: 'remembered' });
        logSettle(request.log, asked, turn, undefined);
        return answer;
      case 'cancelled':
        settles.inc({ result: 'busy' });
        observe('busy');
        throw new FacilitatorBusyError();
      case 'refused':
        // Nothing was included, and nothing is remembered: the payment failed, and the signature may be used again
        settles.inc({ result: 'relayer_refused' });
        observe('relayer_refused');
        request.log.warn({ ...asked, payer: answer.payer ?? null, result: 'relayer_refused', transaction: answer.transaction || null, reason: answer.errorReason ?? null,
          ...answer.errorMessage === undefined ? {} : { message: answer.errorMessage } }, 'The node refused the relayer\'s transaction: the settlement failed, and nothing was included');

        return answer;
      case 'stopped':
        if (flight.transaction !== undefined) {
          settles.inc({ result: 'pending' });
          return pendingOf(flight);
        }
        settles.inc({ result: 'busy' });
        throw new FacilitatorBusyError();
      case 'unavailable':
        break;
      default:
        if (answer.success || !transientReasons.has(answer.errorReason ?? '')) {
          settles.inc({ result: answer.success ? 'settled' : reasonLabel(answer.errorReason) });
          observe(path);
          logSettle(request.log, asked, turn, performance.now() - started);

          return answer;
        }
    }
    settles.inc({ result: 'rpc_unavailable' });
    observe('rpc_unavailable');
    request.log.warn({ ...asked, result: 'rpc_unavailable', reason: answer.errorReason ?? null, ...answer.errorMessage === undefined ? {} : { message: answer.errorMessage } },
      'Couldn\'t settle a payment: the NEAR RPC didn\'t answer');
    throw new RpcUnavailableError(answer.errorReason ?? 'unknown');
  });

  return {
    ...server,
    /**
     * Takes no more settles, cancels those not signed yet, gives those that have signed their first
     * send (`sendMs` at most), then stops the relayer's polls, and waits for every request's answer.
     */
    close: async () => {
      closing = true;
      const closed = server.close();
      for (const flight of live) {
        if (flight.transaction === undefined)
          flight.cancelled = true;
      }
      const sending = [...live].filter(flight => flight.transaction !== undefined).map(flight => flight.sendPhase);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(sending), new Promise<void>(resolve => {
        timer = setTimeout(resolve, config.timeouts.connectMs);
      })]);
      clearTimeout(timer);
      relayer.stop();
      await closed;
    },
  };
};
