import { AnyfareError } from '@anyfare/common';

/** No credential: the request has no `Authorization: Bearer` key. */
export class UnauthorizedError extends AnyfareError {
  readonly code = 'unauthorized';

  constructor() {
    super('This endpoint needs a master key: Authorization: Bearer <key>');
  }
}

/** An unknown, revoked, or malformed key. The message never says which. */
export class InvalidKeyError extends AnyfareError {
  readonly code = 'invalid_key';

  constructor() {
    super('The key is invalid or revoked');
  }
}

/** A key of the other kind. Each kind works on one host only. */
export class WrongKeyTypeError extends AnyfareError {
  readonly code = 'wrong_key_type';

  constructor(message: string) {
    super(message);
  }
}
