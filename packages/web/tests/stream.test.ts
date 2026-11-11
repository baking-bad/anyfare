import { describe, expect, it } from 'vitest';

import type { Call } from '../src/api/types';
import { createCallStream, parseCall, type EventSourceLike } from '../src/live/stream';
import { sampleCall } from './support/fakeApi';

const now = Date.parse('2026-11-11T12:00:00.000Z');

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private listener: ((event: { readonly data: unknown }) => void) | undefined;
  constructor(readonly url: string) {}
  addEventListener(_type: 'call', listener: (event: { readonly data: unknown }) => void): void {
    this.listener = listener;
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  send(data: unknown): void {
    this.listener?.({ data });
  }
}

const setup = () => {
  const sources: FakeSource[] = [];
  const timers: { readonly callback: () => void; readonly ms: number; cleared: boolean }[] = [];
  const calls: Call[] = [];
  const connection: boolean[] = [];
  const stream = createCallStream({
    url: 'https://api.example.com/v1/calls/stream',
    onCall: call => calls.push(call),
    onConnection: connected => connection.push(connected),
    open: url => {
      const source = new FakeSource(url);
      sources.push(source);

      return source;
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);

      return timer;
    },
    clearTimer: timer => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });

  return { stream, sources, timers, calls, connection };
};

describe('the calls stream', () => {
  it('delivers the calls it can read and ignores the rest', () => {
    const { stream, sources, calls } = setup();
    stream.start();

    sources[0]!.send(JSON.stringify(sampleCall(1, now)));
    sources[0]!.send('not json');
    sources[0]!.send(JSON.stringify({ id: 'pay_x' }));

    expect(calls.map(call => call.id)).toEqual(['pay_sample0001']);
    expect(parseCall(undefined)).toBeUndefined();
  });

  it('opens once, however many times it is started', () => {
    const { stream, sources } = setup();

    stream.start();
    stream.start();

    expect(sources).toHaveLength(1);
  });

  it('lets the browser retry while it is connecting, and opens a new one when the connection is closed', () => {
    const { stream, sources, timers, connection } = setup();
    stream.start();
    sources[0]!.onopen?.({});

    // Dropped, and the browser is retrying by itself
    sources[0]!.readyState = 0;
    sources[0]!.onerror?.({});
    expect(timers).toHaveLength(0);

    // The server refused (such as a 429): the browser has given up
    sources[0]!.readyState = 2;
    sources[0]!.onerror?.({});
    expect(timers.map(timer => timer.ms)).toEqual([3_000]);
    timers[0]!.callback();
    expect(sources).toHaveLength(2);
    expect(connection).toEqual([true, false, false]);
  });

  it('waits longer after each failure, up to a limit, and starts over once it connects', () => {
    const { stream, sources, timers } = setup();
    stream.start();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      sources[attempt]!.readyState = 2;
      sources[attempt]!.onerror?.({});
      timers[attempt]!.callback();
    }
    expect(timers.map(timer => timer.ms)).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);

    sources[6]!.onopen?.({});
    sources[6]!.readyState = 2;
    sources[6]!.onerror?.({});
    expect(timers[6]!.ms).toBe(3_000);
  });

  it('closes on stop, cancels a retry, and opens again on start', () => {
    const { stream, sources, timers } = setup();
    stream.start();
    sources[0]!.readyState = 2;
    sources[0]!.onerror?.({});

    stream.stop();
    expect(timers[0]!.cleared).toBe(true);
    stream.start();
    expect(sources).toHaveLength(2);
    stream.stop();

    expect(sources[1]!.closed).toBe(true);
  });
});
