import { formatUsd, type Clock } from '@anyfare/common';
import { InvalidKeyError, WrongKeyTypeError, type KeyPrefixes, type PaymentKey } from '@anyfare/core';

import { createCreditsDetector, type Credential, type CreditsCredential } from './credentials.js';
import { HoldRefusedError, KeyPriceLimitError } from './errors.js';
import type { CreditsLedger, KeyStore } from './ports.js';
import type { Authorization, PaymentRail, Quote, Receipt } from './rail.js';

// The credits receipt
export const creditsReceiptHeader = 'anyfare-receipt';

export interface CreditsRailOptions {
  // Looked up by hash. The proxy passes one with a short cache.
  readonly keys: KeyStore;
  readonly ledger: CreditsLedger;
  // For key expiry
  readonly clock: Clock;
  readonly keyPrefixes: KeyPrefixes;
  // `POST <api url>/v1/accounts`, for the 402
  readonly signupUrl: string;
}

export interface CreditsRail extends PaymentRail {
  readonly name: 'credits';
  /**
   * The payment key behind a credits credential: a master key is `401 wrong_key_type`, and anything
   * else that isn't an active, unexpired payment key is `401 invalid_key`.
   */
  authenticate(credential: CreditsCredential): Promise<PaymentKey>;
}

/** `id="<payment ID>", amount="<USD>", currency="USD"`: a structured field dictionary. */
export const formatCreditsReceipt = (paymentId: string, amount: bigint): string =>
  `id="${paymentId}", amount="${formatUsd(amount)}", currency="USD"`;

const creditsOnly = (credential: Credential): CreditsCredential => {
  if (credential.rail !== 'credits')
    throw new TypeError(`The credits rail can't take a ${credential.rail} credential`);

  return credential;
};

const receiptOf = ({ paymentId, amount }: Pick<Authorization, 'paymentId' | 'amount'>): Receipt => ({
  headers: { [creditsReceiptHeader]: formatCreditsReceipt(paymentId, amount) },
});

/**
 * Credits: a payment key from `Authorization: Bearer`, a hold through the ledger that checks the
 * balance and the key's spend at once, then a capture after a billable response or a release
 * otherwise. The ledger writes each status change with its money movement.
 */
export const createCreditsRail = ({ keys, ledger, clock, keyPrefixes, signupUrl }: CreditsRailOptions): CreditsRail => {
  const authenticate = async ({ key }: CreditsCredential): Promise<PaymentKey> => {
    if (key.kind === 'master')
      throw new WrongKeyTypeError('A master key works only on the Platform API. Paid calls take a payment key.');
    if (key.kind === 'invalid')
      throw new InvalidKeyError();

    const found = await keys.findByHash(key.hash);
    // The store finds active keys only. An expired key is refused like a revoked one.
    if (!found || found.revokedAt !== undefined || (found.expiresAt !== undefined && found.expiresAt.getTime() <= clock.now().getTime()))
      throw new InvalidKeyError();

    return found;
  };

  return {
    name: 'credits',
    settlesBeforeResponse: false,
    detect: createCreditsDetector(keyPrefixes),
    challenge: async quote => ({
      body: {
        credits: {
          price: formatUsd(quote.priceMicroUsd),
          currency: 'USD',
          authorization: 'Bearer <payment key>',
          signup: { method: 'POST', url: signupUrl },
        },
      },
    }),
    authenticate,
    authorize: async (credential, quote: Quote) => {
      const key = await authenticate(creditsOnly(credential));
      if (key.maxPrice !== undefined && quote.priceMicroUsd > key.maxPrice)
        throw new KeyPriceLimitError();

      const result = await ledger.hold({
        payment: {
          id: quote.paymentId,
          requestId: quote.requestId,
          rail: 'credits',
          buyerAccountId: key.accountId,
          keyId: key.id,
          targetHost: quote.subject.targetHost,
          targetPath: quote.subject.targetPath,
          network: undefined,
          asset: undefined,
          atomicAmount: undefined,
          amount: quote.priceMicroUsd,
        },
        dailyBudget: key.dailyBudget,
        allowance: key.allowance,
      });
      if (!result.ok)
        throw new HoldRefusedError(result.refusal);

      const charge = { paymentId: quote.paymentId, amount: quote.priceMicroUsd };

      return { rail: 'credits', ...charge, buyer: `account:${key.accountId}`, receipt: receiptOf(charge) };
    },
    finalize: async authorization => {
      await ledger.capture({ paymentId: authorization.paymentId });

      return receiptOf(authorization);
    },
    abort: async authorization => {
      await ledger.release({ paymentId: authorization.paymentId });
    },
  };
};
