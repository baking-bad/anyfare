import { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import type { CallRecord } from '@anyfare/db';
import { createFakeClock } from '@anyfare/testing';

import type { CallFeed } from '../../src/calls/feed.js';
import { createCallStreams, maxUnsentBytes, ShuttingDownError, TooManyStreamsError } from '../../src/calls/stream.js';
import { createCallViews } from '../../src/calls/view.js';

const start = Date.parse('2026-11-12T10:00:00.000Z');
let config: PlatformConfig;

beforeAll(async () => {
  config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
});

const call = (id: string, finishedAfterMs: number, host = 'api.example.com'): CallRecord => ({
  id, rail: 'credits', status: 'captured', targetHost: host, targetPath: '/v1/x', network: undefined, asset: undefined, amount: 1_000n, fee: 0n,
  upstreamStatus: 200, upstreamLatencyMs: 10, transactionHash: undefined, createdAt: new Date(start), updatedAt: new Date(start + finishedAfterMs),
  details: undefined, leg: undefined,
});

// A feed the test drives by hand
const createManualFeed = () => {
  const listeners = new Set<(call: CallRecord) => void>();
  const feed: CallFeed = {
    subscribe: listener => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    close: async () => undefined,
  };

  return { feed, push: (row: CallRecord) => listeners.forEach(listener => listener(row)), get listeners() {
    return listeners.size;
  } };
};

// A request from an address, and a reply that keeps the body it is sent
const connection = (ip: string) => {
  // The response: what it holds unsent, and whether it was destroyed
  const raw = Object.assign(new EventEmitter(), {
    writableLength: 0,
    destroyed: false,
    destroy() {
      raw.destroyed = true;
      raw.emit('close');
    },
  });
  let body: PassThrough | undefined;
  const reply = {
    raw,
    header: () => reply,
    status: () => reply,
    headers: () => reply,
    send: (payload: PassThrough) => {
      body = payload;

      return reply;
    },
  };

  return {
    request: { ip } as unknown as FastifyRequest,
    reply: reply as unknown as FastifyReply,
    raw,
    get body() {
      return body!;
    },
  };
};

const setup = (caps = { maxPerIp: 5, maxTotal: 10 }) => {
  const manual = createManualFeed();
  const streams = createCallStreams({ feed: manual.feed, views: createCallViews(config), caps, clock: createFakeClock(new Date(start)), pingMs: 60_000 });

  return Object.assign(manual, { streams });
};

const read = (body: PassThrough): string => {
  const chunks: string[] = [];
  let chunk: Buffer | null;
  while ((chunk = body.read() as Buffer | null) !== null)
    chunks.push(chunk.toString('utf8'));

  return chunks.join('');
};

describe('the open streams of calls', () => {
  it('sends each call finished after the stream opened that matches its filter, as one line of JSON', () => {
    const { streams, push } = setup();
    const client = connection('203.0.113.7');
    streams.open(client.request, client.reply, view => view.service.includes('weather'));

    push(call('pay_old', -1, 'weather.example.com'));
    push(call('pay_other', 5, 'quotes.example.com'));
    push(call('pay_new', 5, 'weather.example.com'));

    const text = read(client.body);
    expect(text.startsWith('retry: 3000\n\n')).toBe(true);
    const events = text.split('\n\n').filter(frame => frame.startsWith('event: call'));
    expect(events).toHaveLength(1);
    expect(events[0]!.split('\n')).toEqual(['event: call', expect.stringMatching(/^data: \{.*"id":"pay_new".*\}$/)]);
  });

  it('drops a client that falls behind, so what it hasn\'t taken never grows past the limit', () => {
    const context = setup();
    const { streams, push } = context;
    const slow = connection('203.0.113.8');
    streams.open(slow.request, slow.reply, () => true);
    expect(context.listeners).toBe(1);

    for (let index = 0; index < 1_000 && !slow.body.destroyed; index += 1)
      push(call(`pay_slow_${index}`, 1));

    expect(slow.body.destroyed).toBe(true);
    expect(slow.body.writableLength + slow.body.readableLength).toBeLessThanOrEqual(maxUnsentBytes);
  });

  it('caps open streams per client, counting an IPv6 /64 as one, and in all', () => {
    const { streams } = setup({ maxPerIp: 2, maxTotal: 3 });
    const open = (ip: string) => {
      const client = connection(ip);
      streams.open(client.request, client.reply, () => true);

      return client;
    };

    const first = open('2001:db8:1:2::10');
    open('2001:db8:1:2::20');
    expect(() => open('2001:db8:1:2::30')).toThrow(TooManyStreamsError);
    open('203.0.113.9');
    expect(() => open('203.0.113.10')).toThrow(TooManyStreamsError);

    // A client that goes frees its place
    first.raw.emit('close');
    expect(streams.size).toBe(2);
    open('203.0.113.10');
  });

  it('ends every stream at shutdown, and lets go of the feed once none is open', async () => {
    const context = setup();
    const { streams } = context;
    const client = connection('203.0.113.11');
    streams.open(client.request, client.reply, () => true);
    expect(context.listeners).toBe(1);

    // Its client has taken everything
    read(client.body);
    streams.endAll();
    read(client.body);
    await new Promise(resolve => client.body.once('close', resolve));

    expect([client.body.writableEnded, client.raw.destroyed]).toEqual([true, false]);
    expect([streams.size, context.listeners]).toEqual([0, 0]);
  });

  it('destroys at shutdown a stream that still holds what its client hasn\'t taken, rather than wait for it', () => {
    const { streams } = setup();
    const behind = connection('203.0.113.12');
    const flushing = connection('203.0.113.13');
    streams.open(behind.request, behind.reply, () => true);
    streams.open(flushing.request, flushing.reply, () => true);
    read(flushing.body);
    // Taken from the stream, but not yet out on the socket
    flushing.raw.writableLength = 120;

    streams.endAll();

    expect([behind.body.destroyed, behind.raw.destroyed]).toEqual([true, true]);
    expect([flushing.body.destroyed, flushing.raw.destroyed]).toEqual([true, true]);
    expect(streams.size).toBe(0);
  });

  it('opens no stream once shutdown began: 503 shutting_down, to connect again elsewhere', () => {
    const { streams } = setup();
    streams.endAll();
    const late = connection('203.0.113.14');
    const headers: Record<string, string> = {};
    const reply = Object.assign(late.reply, { header: (name: string, value: string) => {
      headers[name] = value;

      return reply;
    } });

    expect(() => streams.open(late.request, reply, () => true)).toThrow(ShuttingDownError);
    expect(headers).toEqual({ 'retry-after': '1' });
    expect(streams.size).toBe(0);
  });
});
