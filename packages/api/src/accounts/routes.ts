import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd } from '@anyfare/common';
import { InvalidKeyError, type Account } from '@anyfare/core';

import { object, string, time, usdString } from '../schemas.js';
import { authenticatedAccount, masterKeySecurity } from './auth.js';
import type { AllowConsole } from './consoleCors.js';
import type { FreeCreditsDecider } from './freeCredits.js';
import type { AccountService } from './service.js';

export const lostKeyNotice = 'Store the master key now: it is shown only once. A lost master key can\'t be recovered, '
  + 'and the account is lost with it.';

// Signing up takes nothing: no body, an empty body, or an empty object. `maxProperties` rather than
// `additionalProperties: false`, because Fastify's validator drops extra properties instead of refusing them.
const signupBodySchema = {
  type: 'object',
  maxProperties: 0,
} as const;

const accountSchema = object({ id: string, createdAt: time });
const signupSchema = object({
  id: string,
  createdAt: time,
  masterKey: { type: 'string', description: 'The master key: shown this once' },
  freeCredits: { ...usdString, description: 'The Credits the account was given, in USD: "0" when none' },
  notice: string,
});
const rotateSchema = object({ masterKey: { type: 'string', description: 'The new master key: shown this once' } });

export interface AccountRoutesOptions {
  readonly accounts: AccountService;
  // The master key hook
  readonly authenticate: onRequestHookHandler;
  // The per-IP signup limit
  readonly signupLimit: onRequestHookHandler;
  // The free Credits a new account gets
  readonly freeCredits: FreeCreditsDecider;
  // The console's CORS, first in each scope
  readonly allowConsole: AllowConsole;
}

const toAccountBody = (account: Account) => ({
  id: account.id,
  createdAt: account.createdAt.toISOString(),
});

/**
 * `POST /v1/accounts`, and behind the master key, `GET /v1/account` and
 * `POST /v1/account/master-key/rotate`. A key appears once, in the response that creates it. A new
 * account's answer says what free Credits it got, `"0"` when none. The console's origin may call each.
 */
export const registerAccountRoutes = (app: FastifyInstance, { accounts, authenticate, signupLimit, freeCredits, allowConsole }: AccountRoutesOptions): void => {
  app.register(async scope => {
    allowConsole(scope);

    scope.post<{ Body: Record<string, never> | undefined }>('/v1/accounts', {
      onRequest: signupLimit,
      // No body is the same as an empty one
      preValidation: async request => {
        request.body ??= {};
      },
      schema: {
        summary: 'Sign up: a new account and its master key, shown once',
        description: 'No key, and no body. Limited per address. A new account may be given free Credits: `freeCredits` says how many.',
        tags: ['accounts'],
        errors: ['rate_limited'],
        body: signupBodySchema,
        response: { 201: signupSchema },
      },
    }, async (request, reply) => {
      // Decided once the signup limit and the body let the request through, so a refused sign-up uses up no gift
      const gift = await freeCredits(request);
      const { account, masterKey, freeCredits: given } = await accounts.create({ requestId: request.id, freeCredits: gift });
      const key = masterKey.expose();
      masterKey.destroy();
      // The account's ID only, never the key
      request.log.info({ accountId: account.id, freeCredits: formatUsd(given) }, 'An account was created');

      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send({ ...toAccountBody(account), masterKey: key, freeCredits: formatUsd(given), notice: lostKeyNotice });
    });
  });

  app.register(async scope => {
    allowConsole(scope);
    scope.addHook('onRequest', authenticate);

    scope.get('/v1/account', {
      schema: { summary: 'The account the master key belongs to', tags: ['accounts'], security: masterKeySecurity, response: { 200: accountSchema } },
    }, async request => {
      const account = await accounts.get(authenticatedAccount(request).accountId);
      // An active key always has its account
      if (!account)
        throw new InvalidKeyError();

      return toAccountBody(account);
    });

    scope.post('/v1/account/master-key/rotate', {
      schema: {
        summary: 'A new master key: the one used stops working at once',
        tags: ['accounts'],
        security: masterKeySecurity,
        response: { 200: rotateSchema },
      },
    }, async (request, reply) => {
      const { accountId, keyId } = authenticatedAccount(request);
      const masterKey = await accounts.rotateMasterKey({ accountId, keyId, requestId: request.id });
      const key = masterKey.expose();
      masterKey.destroy();
      request.log.info({ accountId, revokedKeyId: keyId }, 'A master key was rotated');

      return reply.header('cache-control', 'no-store').send({ masterKey: key });
    });
  });
};
