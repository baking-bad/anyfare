import type { FastifyInstance } from 'fastify';

import { formatUsd, type Clock, type KeyScheme, type MicroUsd } from '@anyfare/common';
import { utcDay, type CreditsBalance, type KeySpend } from '@anyfare/core';
import type { CreditsRail } from '@anyfare/payments';

import { KeyRequiredError } from '../errors.js';
import type { ProxyLimits } from '../payments/limits.js';

export const keyPath = '/_/key';

/** The payment key in the OpenAPI document, and the codes a route that needs one answers without a good one. */
export const paymentKeyScheme = {
  description: 'A payment key, as Authorization: Bearer <key>. It is made with the master key on the Platform API, with its own limits. '
    + 'It works on this host only.',
  errors: ['unauthorized', 'invalid_key', 'wrong_key_type'],
} as const satisfies KeyScheme;

// A response schema keeps out any field it doesn't name: this one names every field the route sends, in its order
const string = { type: 'string' } as const;
const usd = { type: 'string', description: 'USD, as a decimal string' } as const;
const nullableUsd = { type: ['string', 'null'], description: 'USD, as a decimal string. Null: no such limit' } as const;
const nullableTime = { type: ['string', 'null'], format: 'date-time' } as const;
const object = <TProperties extends Record<string, unknown>>(properties: TProperties) =>
  ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false }) as const;

const keyStatusSchema = object({
  id: string,
  label: { type: ['string', 'null'] },
  allowance: nullableUsd,
  dailyBudget: usd,
  maxPrice: nullableUsd,
  expiresAt: nullableTime,
  createdAt: { type: 'string', format: 'date-time' },
  spent: object({ today: usd, total: usd }),
  remaining: object({
    allowance: nullableUsd,
    dailyBudget: usd,
    balance: { ...usd, description: 'What the account can spend now, in USD' },
  }),
});

export interface KeyRouteOptions {
  readonly credits: Pick<CreditsRail, 'detect' | 'authenticate'>;
  readonly limits: Pick<ProxyLimits, 'paymentKey'>;
  readonly ledger: {
    keySpend(keyIds: readonly string[], day: string): Promise<ReadonlyMap<string, KeySpend>>;
    balance(accountId: string): Promise<CreditsBalance>;
  };
  readonly clock: Clock;
}

const remaining = (limit: MicroUsd, spent: MicroUsd): string => formatUsd(limit > spent ? limit - spent : 0n);

/**
 * `GET /_/key`: with a payment key, its limits and what's left of the allowance, of today's budget,
 * and of the balance, so an agent can check before it calls. The fields are those of `GET /v1/keys` on
 * the Platform API, plus the balance.
 */
export const registerKeyRoute = (app: FastifyInstance, { credits, limits, ledger, clock }: KeyRouteOptions): void => {
  app.get(keyPath, {
    schema: {
      summary: 'A payment key\'s limits and what is left of them, and the balance',
      description: 'Check before a call: the fields are those of the key on the Platform API, and the balance the account can spend now.',
      tags: ['keys'],
      security: [{ paymentKey: [] }],
      errors: ['rate_limited'],
      response: { 200: keyStatusSchema },
    },
  }, async (request, reply) => {
    const credential = credits.detect(request.headers);
    if (credential?.rail !== 'credits')
      throw new KeyRequiredError();
    if (credential.key.kind === 'payment')
      await limits.paymentKey(credential.key.hash);

    const key = await credits.authenticate(credential);
    const [spend, balance] = await Promise.all([ledger.keySpend([key.id], utcDay(clock.now())), ledger.balance(key.accountId)]);
    const spent = spend.get(key.id) ?? { today: 0n, total: 0n };

    return reply.header('cache-control', 'no-store').send({
      id: key.id,
      label: key.label ?? null,
      allowance: key.allowance === undefined ? null : formatUsd(key.allowance),
      dailyBudget: formatUsd(key.dailyBudget),
      maxPrice: key.maxPrice === undefined ? null : formatUsd(key.maxPrice),
      expiresAt: key.expiresAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
      spent: { today: formatUsd(spent.today), total: formatUsd(spent.total) },
      remaining: {
        allowance: key.allowance === undefined ? null : remaining(key.allowance, spent.total),
        dailyBudget: remaining(key.dailyBudget, spent.today),
        balance: formatUsd(balance.available),
      },
    });
  });
};
