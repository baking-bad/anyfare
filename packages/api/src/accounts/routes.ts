import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { formatUsd } from '@anyfare/common';
import { InvalidKeyError, type Account } from '@anyfare/core';

import { authenticatedAccount } from './auth.js';
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

export interface AccountRoutesOptions {
  readonly accounts: AccountService;
  // The master key hook
  readonly authenticate: onRequestHookHandler;
  // The per-IP signup limit
  readonly signupLimit: onRequestHookHandler;
  // The free Credits a new account gets
  readonly freeCredits: FreeCreditsDecider;
}

const toAccountBody = (account: Account) => ({
  id: account.id,
  createdAt: account.createdAt.toISOString(),
});

/**
 * `POST /v1/accounts`, and behind the master key, `GET /v1/account` and
 * `POST /v1/account/master-key/rotate`. A key appears once, in the response that creates it. A new
 * account's answer says what free Credits it got, `"0"` when none.
 */
export const registerAccountRoutes = (app: FastifyInstance, { accounts, authenticate, signupLimit, freeCredits }: AccountRoutesOptions): void => {
  app.post<{ Body: Record<string, never> | undefined }>('/v1/accounts', {
    onRequest: signupLimit,
    // No body is the same as an empty one
    preValidation: async request => {
      request.body ??= {};
    },
    schema: { body: signupBodySchema },
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

  app.register(async scope => {
    scope.addHook('onRequest', authenticate);

    scope.get('/v1/account', async request => {
      const account = await accounts.get(authenticatedAccount(request).accountId);
      // An active key always has its account
      if (!account)
        throw new InvalidKeyError();

      return toAccountBody(account);
    });

    scope.post('/v1/account/master-key/rotate', async (request, reply) => {
      const { accountId, keyId } = authenticatedAccount(request);
      const masterKey = await accounts.rotateMasterKey({ accountId, keyId, requestId: request.id });
      const key = masterKey.expose();
      masterKey.destroy();
      request.log.info({ accountId, revokedKeyId: keyId }, 'A master key was rotated');

      return reply.header('cache-control', 'no-store').send({ masterKey: key });
    });
  });
};
