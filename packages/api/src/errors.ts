import { AnyfareError, type ErrorStatusTable } from '@anyfare/common';

// Every AnyfareError code the Platform API answers with, and its status. A code missing here answers
// an opaque 500. Endpoints add their codes as they arrive.
export const errorStatuses = {
  // A malformed request that Fastify's own checks don't catch
  invalid_request: 400,
  unauthorized: 401,
  invalid_key: 401,
  wrong_key_type: 401,
  rate_limited: 429,
  not_found: 404,
  // A credit's reference reused for another account or amount
  idempotency_conflict: 409,
} as const satisfies ErrorStatusTable;

/** A request the route can't take: the message says what's wrong, never quoting a value it carried. */
export class InvalidRequestError extends AnyfareError {
  readonly code = 'invalid_request';
}

/** No such resource for the caller, such as another account's payment key. */
export class NotFoundError extends AnyfareError {
  readonly code = 'not_found';
}
