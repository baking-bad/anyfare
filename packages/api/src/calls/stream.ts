import { PassThrough } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { AnyfareError, type Clock } from '@anyfare/common';
import { rateLimitClient, type PlatformConfig } from '@anyfare/core';
import type { CallRecord } from '@anyfare/db';

import type { CallFeed } from './feed.js';
import type { CallView, CallViews } from './view.js';

export const defaultPingMs = 15_000;
// How long a client waits before it connects again after the stream breaks off
export const reconnectMs = 3_000;
// What a stream may hold that its client hasn't taken yet. A client that falls this far behind is dropped.
export const maxUnsentBytes = 64 * 1024;
// When a client over a cap may try again
const capRetryAfterSeconds = 30;

export const streamHeaders = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  // nginx and its kind hold nothing back
  'x-accel-buffering': 'no',
} as const;

/** Too many open streams: from this client, or on this process. Answers 429 with Retry-After. */
export class TooManyStreamsError extends AnyfareError {
  readonly code = 'rate_limited';
}

/** The process is shutting down: no new stream. Answers 503 with Retry-After, so the client connects again. */
export class ShuttingDownError extends AnyfareError {
  readonly code = 'shutting_down';

  constructor() {
    super('This server is shutting down. Connect again: another one takes the stream.');
  }
}

interface OpenStream {
  readonly client: string;
  readonly openedAt: number;
  readonly matches: (call: CallView) => boolean;
  readonly body: PassThrough;
  // The response it goes out on
  readonly raw: FastifyReply['raw'];
}

export interface CallStreamsOptions {
  readonly feed: CallFeed;
  readonly views: Pick<CallViews, 'callOf'>;
  readonly caps: PlatformConfig['callStream'];
  readonly clock: Clock;
  // Default: 15 s
  readonly pingMs?: number;
}

/**
 * The open streams of finished calls on this process, within the caps per client IP and in all. Each
 * call is turned into its line once and written to every stream whose filter it matches, opened before
 * the call was finished.
 */
export const createCallStreams = ({ feed, views, caps, clock, pingMs = defaultPingMs }: CallStreamsOptions) => {
  const streams = new Set<OpenStream>();
  const perClient = new Map<string, number>();
  let unsubscribe: (() => void) | undefined;
  let pinger: NodeJS.Timeout | undefined;
  // Once shutdown began, no stream opens
  let closing = false;

  // A client that has fallen behind is dropped, so its stream never grows past the limit
  const write = (stream: OpenStream, text: string): void => {
    const { body } = stream;
    if (body.destroyed || body.writableEnded)
      return;
    if (body.writableLength + body.readableLength + Buffer.byteLength(text) > maxUnsentBytes) {
      body.destroy();
      return;
    }
    body.write(text);
  };

  const onCall = (record: CallRecord): void => {
    const call = views.callOf(record);
    const finishedAt = record.updatedAt.getTime();
    let line: string | undefined;
    for (const stream of streams) {
      if (finishedAt < stream.openedAt || !stream.matches(call))
        continue;
      line ??= `event: call\ndata: ${JSON.stringify(call)}\n\n`;
      write(stream, line);
    }
  };

  const remove = (stream: OpenStream): void => {
    if (!streams.delete(stream))
      return;
    const count = (perClient.get(stream.client) ?? 1) - 1;
    if (count > 0)
      perClient.set(stream.client, count);
    else
      perClient.delete(stream.client);
    if (streams.size === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
      clearInterval(pinger);
      pinger = undefined;
    }
  };

  return {
    /** Opens a stream for the request. Throws TooManyStreamsError over a cap, and ShuttingDownError once shutdown began. */
    open: (request: FastifyRequest, reply: FastifyReply, matches: (call: CallView) => boolean): FastifyReply => {
      // Such as a request on a connection kept alive past the start of shutdown
      if (closing) {
        reply.header('retry-after', '1');
        throw new ShuttingDownError();
      }
      const client = rateLimitClient(request.ip);
      const fromClient = perClient.get(client) ?? 0;
      if (fromClient >= caps.maxPerIp || streams.size >= caps.maxTotal) {
        reply.header('retry-after', String(capRetryAfterSeconds));
        throw new TooManyStreamsError(fromClient >= caps.maxPerIp
          ? 'Too many open streams from this address. Close one, or try again later.'
          : 'Too many open streams. Try again later.');
      }

      const stream: OpenStream = { client, openedAt: clock.now().getTime(), matches, body: new PassThrough(), raw: reply.raw };
      streams.add(stream);
      perClient.set(client, fromClient + 1);
      // Ended by us, or destroyed once the client has gone
      stream.body.once('close', () => remove(stream));
      reply.raw.once('close', () => {
        remove(stream);
        stream.body.destroy();
      });
      unsubscribe ??= feed.subscribe(onCall);
      if (!pinger) {
        pinger = setInterval(() => {
          for (const each of streams)
            write(each, ': ping\n\n');
        }, pingMs);
        pinger.unref();
      }
      stream.body.write(`retry: ${reconnectMs}\n\n`);

      return reply.status(200).headers(streamHeaders).send(stream.body);
    },
    /**
     * Ends every open stream and refuses new ones, so shutdown never waits for a stream. One that still
     * holds what its client hasn't taken is destroyed, not waited for.
     */
    endAll: (): void => {
      closing = true;
      for (const stream of streams) {
        const { body, raw } = stream;
        if (body.writableLength + body.readableLength + raw.writableLength > 0) {
          body.destroy();
          raw.destroy();
        }
        else
          body.end();
      }
    },
    get size(): number {
      return streams.size;
    },
  };
};

export type CallStreams = ReturnType<typeof createCallStreams>;
