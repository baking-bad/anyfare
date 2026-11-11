import type { Call } from '../api/types';

// The live stream of finished calls, over server-sent events. A browser's EventSource retries a dropped
// connection by itself, but gives up for good when the server answers with an error, such as a 429 when
// too many streams are open. So when the connection is closed, this opens a new one after a pause that
// grows, up to a limit.

/** The parts of `EventSource` this uses, so a test can stand in for it. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: 'call', listener: (event: { readonly data: unknown }) => void): void;
  close(): void;
}

const closedState = 2;

export interface CallStreamOptions {
  readonly url: string;
  readonly onCall: (call: Call) => void;
  // Called when the stream connects (true) and when it drops or stops (false)
  readonly onConnection?: (connected: boolean) => void;
  readonly open?: (url: string) => EventSourceLike;
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface CallStream {
  /** Opens the stream, unless it is open or about to be. */
  readonly start: () => void;
  /** Closes the stream and stops retrying. `start` opens it again. */
  readonly stop: () => void;
}

/** Whether a stream event's data is a call. The page trusts nothing but the fields it shows. */
export const isCall = (value: unknown): value is Call => {
  if (typeof value !== 'object' || value === null)
    return false;
  const call = value as Record<string, unknown>;

  return typeof call['id'] === 'string' && typeof call['at'] === 'string' && typeof call['service'] === 'string' && typeof call['path'] === 'string'
    && typeof call['paidWith'] === 'string' && typeof call['amount'] === 'string' && (call['status'] === 'paid' || call['status'] === 'free');
};

/** Reads the data of a `call` event: a call as one line of JSON, or `undefined` when it isn't one. */
export const parseCall = (data: unknown): Call | undefined => {
  if (typeof data !== 'string')
    return undefined;
  try {
    const value: unknown = JSON.parse(data);

    return isCall(value) ? value : undefined;
  }
  catch {
    return undefined;
  }
};

export const createCallStream = ({
  url,
  onCall,
  onConnection,
  open = address => new EventSource(address) as unknown as EventSourceLike,
  retryMs = 3_000,
  maxRetryMs = 30_000,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: CallStreamOptions): CallStream => {
  let source: EventSourceLike | undefined;
  let timer: unknown;
  let failures = 0;
  let wanted = false;

  const connect = (): void => {
    timer = undefined;
    if (!wanted || source !== undefined)
      return;
    const current = open(url);
    source = current;
    current.onopen = () => {
      failures = 0;
      onConnection?.(true);
    };
    current.addEventListener('call', event => {
      const call = parseCall(event.data);
      if (call !== undefined)
        onCall(call);
    });
    current.onerror = () => {
      onConnection?.(false);
      // Still connecting: the browser retries by itself. Closed: it won't, so retry here.
      if (current.readyState !== closedState || source !== current)
        return;
      current.close();
      source = undefined;
      failures += 1;
      timer = setTimer(connect, Math.min(maxRetryMs, retryMs * 2 ** (failures - 1)));
    };
  };

  return {
    start: () => {
      wanted = true;
      if (source === undefined && timer === undefined)
        connect();
    },
    stop: () => {
      wanted = false;
      if (timer !== undefined)
        clearTimer(timer);
      timer = undefined;
      source?.close();
      if (source !== undefined)
        onConnection?.(false);
      source = undefined;
      failures = 0;
    },
  };
};
