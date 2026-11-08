import type { LogSink, MicroUsd } from '@anyfare/common';
import type { RailName } from '@anyfare/core';

import type { Credential } from './credentials.js';

/** Request headers as Node gives them: lowercase names. */
export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** What a paid call is for, recorded on its payment row: the target it is routed to. A rail never branches on it. */
export interface PaymentSubject {
  readonly targetHost: string;
  readonly targetPath: string;
}

/** The price of one call, and everything a rail records about it. */
export interface Quote {
  readonly paymentId: string;
  readonly requestId: string | undefined;
  // The canonical pay URL of the resource
  readonly resource: string;
  readonly priceMicroUsd: MicroUsd;
  readonly description: string;
  readonly subject: PaymentSubject;
  // The request's logger, so a rail's lines carry the request ID. Default: the rail's own.
  readonly log?: LogSink;
}

/** One rail's part of the combined `402`: headers, and fields of the JSON body. */
export interface ChallengePart {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

/** Headers that tell the buyer what was paid, such as `Anyfare-Receipt`. */
export interface Receipt {
  readonly headers: Readonly<Record<string, string>>;
  // What an on-chain settlement did, for the log: settled, or broadcast and still settling
  readonly settlement?: { readonly status: 'settled' | 'settling'; readonly transaction: string | undefined };
}

/** An authorized payment: what a rail finalizes after a billable response, or aborts otherwise. */
export interface Authorization {
  readonly rail: RailName;
  readonly paymentId: string;
  readonly amount: MicroUsd;
  // Who pays, for the log: `account:<id>` for credits, the payer for x402 and MPP
  readonly buyer: string;
  // The receipt, when the rail knows it before finalizing. Credits responses stream, so their receipt
  // goes out with the response headers, before the capture.
  readonly receipt: Receipt | undefined;
  // For the log: the network and the asset's registry name an on-chain payment uses
  readonly network?: string;
  readonly asset?: string;
  // The moment after which the payment can no longer settle, in milliseconds since the epoch: the
  // proxy keeps the call under it, so the money can still move after a billable answer. Undefined:
  // the rail has no such moment.
  readonly deadlineMs?: number;
  // The request's logger, from the quote, for the lines finalize and abort write
  readonly log?: LogSink;
}

/** A payment rail: credits, x402, or MPP. */
export interface PaymentRail {
  readonly name: RailName;
  /**
   * Whether the money must move before any upstream byte reaches the buyer: x402 settles, then sends
   * the buffered response. Otherwise the response streams and `finalize` runs after it.
   */
  readonly settlesBeforeResponse: boolean;
  /** This rail's credential in the request, or undefined. */
  detect(headers: RequestHeaders): Credential | undefined;
  /** Its part of the combined `402`, or undefined when it can't take this quote. */
  challenge(quote: Quote): Promise<ChallengePart | undefined>;
  /** Checks the credential against the quote and reserves the money. Throws a coded error when refused. */
  authorize(credential: Credential, quote: Quote): Promise<Authorization>;
  /** Takes the money after a billable response. Running it twice moves money once. */
  finalize(authorization: Authorization): Promise<Receipt>;
  /** Gives the reservation back after a response that isn't billable. Running it twice moves money once. */
  abort(authorization: Authorization): Promise<void>;
}
