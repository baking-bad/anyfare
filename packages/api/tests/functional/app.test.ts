import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, runApp, Secret, type Logger, type Server } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import { createPostgres, createRedis, type Postgres, type Redis } from '@anyfare/db';
import { createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp } from '../../src/app.js';
import { startApi } from '../../src/start.js';

const exampleConfig = { CONFIG_PATH: 'config/example.yaml' };
const silentLogger = createLogger({ level: 'silent' });

interface RunningServer {
  readonly server: Server;
  readonly url: string;
  readonly metricsUrl: string;
}

let config: PlatformConfig;
let database: TestDatabase;
let redis: TestRedis;
const started: Server[] = [];

const start = async (dependencies: { postgres?: Postgres; redis?: Redis; logger?: Logger } = {}): Promise<RunningServer> => {
  const server = createApp({
    config,
    logger: dependencies.logger ?? silentLogger,
    postgres: dependencies.postgres ?? database.postgres,
    redis: dependencies.redis ?? redis,
  });
  server.app.get('/test/boom', async () => {
    throw new Error('upstream 10.0.0.5 said: secret detail');
  });
  started.push(server);
  const { port, metricsPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return { server, url: `http://127.0.0.1:${port}`, metricsUrl: `http://127.0.0.1:${metricsPort}` };
};

// Accepts connections and never answers, like a dependency behind a dead network path
const startBlackhole = async () => {
  const sockets = new Set<Socket>();
  const server = createNetServer(socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      sockets.forEach(socket => socket.destroy());
      await new Promise(resolve => server.close(resolve));
    },
  };
};

const timed = async <TResult>(work: () => Promise<TResult>) => {
  const startedAt = performance.now();
  const result = await work();

  return { result, elapsedMs: performance.now() - startedAt };
};

const captureLogs = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

  return { logger, lines };
};

beforeAll(async () => {
  config = await loadPlatformConfig({ env: exampleConfig });
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
});

afterEach(async () => {
  await Promise.all(started.splice(0).map(server => server.close()));
});

afterAll(async () => {
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

describe('health and readiness', () => {
  it('answers /_/health with 200', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('keeps crawlers off with a robots.txt of its own, as the pay host does, outside its OpenAPI document', async () => {
    const { url } = await start();

    const robots = await fetch(`${url}/robots.txt`);
    const document = await (await fetch(`${url}/openapi.json`)).json() as { paths: Record<string, unknown> };

    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    expect(Object.keys(document.paths)).not.toContain('/robots.txt');
  });

  it('answers /_/ready with 200 when Postgres and Redis are up', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it.each([
    ['refuses connections', 'refused'],
    ['accepts connections but never answers', 'silent'],
  ] as const)('answers /_/ready with 503 within 3 s when Redis %s', async (_case, mode) => {
    const blackhole = await startBlackhole();
    const port = mode === 'silent' ? blackhole.port : await blackhole.close().then(() => blackhole.port);
    const unreachable = createRedis({ url: Secret.from(`redis://127.0.0.1:${port}`), logger: silentLogger });
    try {
      const { url } = await start({ redis: unreachable });

      const { result: response, elapsedMs } = await timed(() => fetch(`${url}/_/ready`));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'failed' } });
      expect(elapsedMs).toBeLessThan(3_000);
    }
    finally {
      await unreachable.close();
      await blackhole.close();
    }
  });

  it('answers /_/ready with 503 within 3 s when Postgres hangs', async () => {
    const blackhole = await startBlackhole();
    const hanging = createPostgres({ url: Secret.from(`postgres://user:password@127.0.0.1:${blackhole.port}/db`), logger: silentLogger });
    try {
      const { url } = await start({ postgres: hanging });

      const { result: response, elapsedMs } = await timed(() => fetch(`${url}/_/ready`));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'not_ready', checks: { postgres: 'failed', redis: 'ok' } });
      expect(elapsedMs).toBeGreaterThanOrEqual(1_950);
      expect(elapsedMs).toBeLessThan(3_000);
    }
    finally {
      await blackhole.close();
      await hanging.close();
    }
  });
});

describe('request ID', () => {
  it('returns an incoming x-request-id and puts it on the request\'s log lines', async () => {
    const { logger, lines } = captureLogs();
    const { url } = await start({ logger });

    const response = await fetch(`${url}/_/ready`, { headers: { 'x-request-id': 'abc-123' } });

    expect(response.headers.get('x-request-id')).toBe('abc-123');
    await vi.waitFor(() => expect(lines.filter(line => line['requestId'] === 'abc-123')).toEqual([
      expect.objectContaining({ msg: 'Request completed', method: 'GET', route: '/_/ready', status: 200 }),
    ]));
  });

  it('generates an ID for a request without one', async () => {
    const { logger, lines } = captureLogs();
    const { url } = await start({ logger });

    const response = await fetch(`${url}/_/health`);

    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await vi.waitFor(() => expect(lines).toContainEqual(expect.objectContaining({ requestId, msg: 'Request completed' })));
  });
});

describe('errors', () => {
  it('answers an unknown route with 404 not_found in the error envelope', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/v1/nothing-here`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('answers a thrown plain Error with an opaque 500 internal_error, with no stack or message', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/test/boom`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(body).not.toMatch(/secret detail|10\.0\.0\.5|app\.test\.ts/);
  });

  it('answers HEAD on a GET route with 404', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/_/health`, { method: 'HEAD' });

    expect(response.status).toBe(404);
  });
});

describe('metrics', () => {
  it('lists the request counter and the latency histogram on the metrics port', async () => {
    const { url, metricsUrl } = await start();
    await fetch(`${url}/_/health`);

    const response = await fetch(`${metricsUrl}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('http_requests_total{method="GET",route="/_/health",status="200"} 1');
    expect(body).toContain('# TYPE http_request_duration_seconds histogram');
    expect(body).toContain('http_request_duration_seconds_count{method="GET",route="/_/health",status="200"} 1');
  });
});

describe('startup', () => {
  it('exits with 1 and logs the reason when the platform config is invalid', async () => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();
    // Equal key prefixes, which platform config forbids
    const override = Buffer.from('keyPrefixes:\n  master: af_test_\n').toString('base64');

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...exampleConfig, CONFIG: override } });

    expect(exit).toHaveBeenCalledWith(1);
    const failure = lines.find(line => line['msg'] === 'Failed to start');
    expect(failure).toMatchObject({ level: 60 });
    expect((failure!['error'] as { message: string }).message).toContain('/keyPrefixes');
  });

  it('exits with 1 and names the missing secret when DATABASE_URL is unset', async () => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...exampleConfig, REDIS_URL: redis.url.expose() } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({
      error: { message: 'Secret DATABASE_URL is not set' },
    });
  });
});

describe('the internal API secret', () => {
  const env = () => ({
    ...exampleConfig,
    DATABASE_URL: database.url.expose(),
    REDIS_URL: redis.url.expose(),
    HOST: '127.0.0.1',
    PORT: '0',
    METRICS_PORT: '0',
    INTERNAL_PORT: '0',
  });

  it.each([
    ['unset', undefined, 'Secret INTERNAL_API_SECRET is not set'],
    ['shorter than 32 characters', 'too-short', 'INTERNAL_API_SECRET must be at least 32 characters'],
  ])('exits with 1 when it is %s, without logging it', async (_case, value, message) => {
    const { logger, lines } = captureLogs();
    const exit = vi.fn();

    await runApp({ name: 'api', start: startApi, logger, exit, env: { ...env(), INTERNAL_API_SECRET: value } });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.find(line => line['msg'] === 'Failed to start')).toMatchObject({ error: { message } });
    if (value)
      expect(JSON.stringify(lines)).not.toContain(value);
  });

  it('starts with a secret of 32 characters, and listens on the internal port', async () => {
    const { logger, lines } = captureLogs();

    const app = await startApi({ env: { ...env(), INTERNAL_API_SECRET: 'x'.repeat(32) }, logger });
    await app.close();

    const started = lines.find(line => line['msg'] === 'Started');
    expect(started).toMatchObject({ ports: { internalPort: expect.any(Number) } });
    expect(JSON.stringify(lines)).not.toContain('x'.repeat(32));
  });
});
