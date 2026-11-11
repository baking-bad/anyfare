import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@anyfare/common';
import { loadPlatformConfig } from '@anyfare/core';
import { auditLog, createRoutingRepository, maxRoutedEndpointsPerHost, routedEndpoints } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const clock = createFakeClock(fixtureTime(0, 9, 0, 0, 0, 0));
const checkedNoon = '2026-11-12T12:00:00.000Z';

let database: TestDatabase;
let redis: TestRedis;
let server: ApiServer;
let internalUrl: string;

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, internalSecret: Secret.from(internalSecret) });
  internalUrl = `http://127.0.0.1:${(await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 })).internalPort!}`;
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const call = async (method: string, path: string, body: unknown, headers: Record<string, string> = { 'x-internal-secret': internalSecret, 'x-internal-caller': 'proxy' }) => {
  const response = await fetch(`${internalUrl}${path}`, {
    method,
    headers: { ...headers, ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const auditOf = async (subjectId: string) => database.db.select().from(auditLog).where(eq(auditLog.subjectId, subjectId));

describe('routed endpoints and the blocklist on the internal API', () => {
  it('registers an endpoint once, with its last quote, and sets its own fee', async () => {
    const first = await call('PUT', '/internal/v1/routed-endpoints', { host: 'api.example.com', path: '/v1/pools', quote: '0.02' });
    const again = await call('PUT', '/internal/v1/routed-endpoints', { host: 'api.example.com', path: '/v1/pools', quote: '0.03' });
    const fee = await call('PUT', '/internal/v1/routed-endpoints/api.example.com/fee', { path: '/v1/pools', feeBps: 150 });
    const unknown = await call('PUT', '/internal/v1/routed-endpoints/api.example.com/fee', { path: '/v1/other', feeBps: 150 });

    expect(first).toEqual({ status: 201, body: { host: 'api.example.com', path: '/v1/pools', result: 'created' } });
    expect([again.status, again.body['result']]).toEqual([200, 'exists']);
    expect(fee).toEqual({ status: 200, body: { host: 'api.example.com', path: '/v1/pools', feeBps: 150 } });
    expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect(await createRoutingRepository({ db: database.db, clock }).endpointFee('api.example.com', '/v1/pools')).toBe(150);
    const [row] = await database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, 'api.example.com'));
    expect(row?.lastPrice).toBe(30_000n);
    expect((await call('PUT', '/internal/v1/routed-endpoints/api.example.com/fee', { path: '/v1/pools', feeBps: null })).body).toMatchObject({ feeBps: null });
    expect((await call('PUT', '/internal/v1/routed-endpoints/api.example.com/fee', { path: '/v1/pools', feeBps: 10_001 })).status).toBe(400);
  });

  it('accepts the request the proxy sends and audits a registration once, under the caller and the request ID', async () => {
    const response = await call('PUT', '/internal/v1/routed-endpoints', { host: 'pay.example.org:8443', path: '/v2/quote?x=1' }, {
      'x-internal-secret': internalSecret, 'x-internal-caller': 'proxy', 'x-request-id': 'req-routed-1',
    });
    await call('PUT', '/internal/v1/routed-endpoints', { host: 'pay.example.org:8443', path: '/v2/quote?x=1' });

    expect(response).toMatchObject({ status: 201, body: { host: 'pay.example.org:8443', result: 'created' } });
    const entries = await auditOf('pay.example.org:8443/v2/quote?x=1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'routing.endpoint_register', actorKind: 'internal_api', actorId: 'proxy', requestId: 'req-routed-1' });
  });

  it('stops at the cap per host, and refuses a host that isn\'t a lowercase DNS name with an optional port', async () => {
    await database.db.insert(routedEndpoints).values(Array.from({ length: maxRoutedEndpointsPerHost }, (_, index) => ({ host: 'busy.example.com', path: `/v1/tx/${index}`, createdAt: clock.now() })));

    expect(await call('PUT', '/internal/v1/routed-endpoints', { host: 'busy.example.com', path: '/v1/tx/new' })).toMatchObject({ status: 200, body: { result: 'capped' } });
    for (const host of ['Not A Host', 'API.example.com', 'localhost', 'a.example.com:port', 'a.example.com:1:2', 'a.example.com:123456'])
      expect((await call('PUT', '/internal/v1/routed-endpoints', { host, path: '/v1' })).status, host).toBe(400);
    expect((await call('PUT', '/internal/v1/routed-endpoints', { host: 'a.example.com', path: 'v1' })).status).toBe(400);
    expect((await call('PUT', '/internal/v1/routed-endpoints', { host: 'a.example.com', path: '/v1', quote: 'free' })).status).toBe(400);
    expect((await call('PUT', '/internal/v1/routed-endpoints', { host: 'a.example.com', path: '/v1', extra: 1 })).status).toBe(400);
  });

  it('lists a check\'s endpoint as checked, with its method, unaudited; a second check updates its time, and a host of the pool only a counted check lists', async () => {
    clock.set(checkedNoon);
    const first = await call('PUT', '/internal/v1/routed-endpoints', { host: 'checked.example.com', path: '/v1/found', quote: '0.0011', kind: 'checked', method: 'POST', mayAddHost: true });
    clock.advance(60_000);
    const again = await call('PUT', '/internal/v1/routed-endpoints', {
      host: 'checked.example.com', path: '/v1/found', quote: '0.0012', kind: 'checked', method: 'GET', mayAddHost: true,
    });
    const uncounted = await call('PUT', '/internal/v1/routed-endpoints', { host: 'uncounted.example.com', path: '/v1/x', quote: '0.0011', kind: 'checked', method: 'GET' });
    // In the pool already, its refresh is counted too
    const refreshed = await call('PUT', '/internal/v1/routed-endpoints', { host: 'checked.example.com', path: '/v1/found', quote: '0.0013', kind: 'checked', method: 'GET' });
    // A name of more than 8 labels is checked, never listed
    const long = await call('PUT', '/internal/v1/routed-endpoints', { host: 'a.b.c.d.e.f.g.h.example.com', path: '/v1/x', kind: 'checked', method: 'GET', mayAddHost: true });

    expect(first).toEqual({ status: 201, body: { host: 'checked.example.com', path: '/v1/found', result: 'created' } });
    expect(again).toEqual({ status: 200, body: { host: 'checked.example.com', path: '/v1/found', result: 'exists' } });
    expect(uncounted).toEqual({ status: 200, body: { host: 'uncounted.example.com', path: '/v1/x', result: 'limited' } });
    expect(refreshed).toEqual({ status: 200, body: { host: 'checked.example.com', path: '/v1/found', result: 'limited' } });
    expect(long).toEqual({ status: 200, body: { host: 'a.b.c.d.e.f.g.h.example.com', path: '/v1/x', result: 'capped' } });
    expect(await database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, 'checked.example.com'))).toEqual([{
      host: 'checked.example.com', path: '/v1/found', feeBps: null, lastPrice: 1_200n, createdAt: new Date(checkedNoon), status: 'checked',
      checkedAt: new Date(Date.parse(checkedNoon) + 60_000), checkMethod: 'GET',
    }]);
    expect(await database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, 'uncounted.example.com'))).toEqual([]);
    // Bounded by its caps, never by the audit log
    expect(await auditOf('checked.example.com/v1/found')).toEqual([]);
    // An endpoint listed only by a check has no fee to set, as one never listed
    expect(await call('PUT', '/internal/v1/routed-endpoints/checked.example.com/fee', { path: '/v1/found', feeBps: 150 })).toMatchObject({
      status: 404, body: { error: { code: 'not_found' } },
    });
    // A host the blocklist names a parent domain of is never listed
    await call('PUT', '/internal/v1/blocklist/blocked-parent.example.com', { reason: 'abuse' });
    expect(await call('PUT', '/internal/v1/routed-endpoints', { host: 'api.blocked-parent.example.com', path: '/v1/x', kind: 'checked', method: 'GET', mayAddHost: true }))
      .toEqual({ status: 200, body: { host: 'api.blocked-parent.example.com', path: '/v1/x', result: 'blocked' } });
    clock.set(fixtureTime(0, 9, 0, 0, 0, 0));
  });

  it('stores a host and a path only: never a check\'s query, a path past its bound, or one that isn\'t printable ASCII', async () => {
    const checked = (path: string, extra: Record<string, unknown> = {}) => call('PUT', '/internal/v1/routed-endpoints', {
      host: 'bounds.example.com', path, kind: 'checked', method: 'GET', mayAddHost: true, ...extra,
    });

    // At the bound of a check's path, and one past it
    expect((await checked(`/${'a'.repeat(511)}`)).status).toBe(201);
    expect((await checked(`/${'b'.repeat(512)}`)).status).toBe(400);
    expect((await checked('/v1/x?token=secret')).status).toBe(400);
    expect((await checked(`/${'c'.repeat(2_999)}`)).status).toBe(400);
    expect((await checked('/v1/x', { method: undefined })).status).toBe(400);
    expect((await checked('/v1/x', { method: 'PUT' })).status).toBe(400);
    // Any routed path: printable ASCII, at most 2,048 characters, so at most 2,048 bytes
    for (const path of ['/v1/é', '/v1/a b', '/v1/\u0000', `/${'d'.repeat(2_048)}`])
      expect((await call('PUT', '/internal/v1/routed-endpoints', { host: 'bounds.example.com', path })).status, path.slice(0, 20)).toBe(400);
    const rows = await database.db.select({ path: routedEndpoints.path }).from(routedEndpoints).where(eq(routedEndpoints.host, 'bounds.example.com'));
    expect(rows.map(row => row.path.length)).toEqual([512]);
    expect(JSON.stringify(rows)).not.toContain('token=secret');
  });

  it('needs the shared secret', async () => {
    const body = { host: 'secret.example.com', path: '/v1' };

    expect((await call('PUT', '/internal/v1/routed-endpoints', body, {})).status).toBe(401);
    expect((await call('PUT', '/internal/v1/routed-endpoints', body, { 'x-internal-secret': 'wrong' })).status).toBe(401);
    expect((await call('PUT', '/internal/v1/blocklist/secret.example.com', { reason: 'x' }, {})).status).toBe(401);
    expect(await database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, 'secret.example.com'))).toEqual([]);
  });

  it('blocks and unblocks a host, with audit entries, and answers 404 for a host that isn\'t blocked', async () => {
    const blocked = await call('PUT', '/internal/v1/blocklist/spam.example.com', { reason: 'abuse reports' });
    const routing = createRoutingRepository({ db: database.db, clock });

    expect(blocked.body).toEqual({ host: 'spam.example.com', blocked: true });
    expect(await routing.isBlocked('spam.example.com')).toBe(true);
    expect((await call('DELETE', '/internal/v1/blocklist/spam.example.com', undefined)).body).toEqual({ host: 'spam.example.com', blocked: false });
    expect(await routing.isBlocked('spam.example.com')).toBe(false);
    expect(await call('DELETE', '/internal/v1/blocklist/spam.example.com', undefined)).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    expect((await call('PUT', '/internal/v1/blocklist/Spam', { reason: 'x' })).status).toBe(400);
    expect((await auditOf('spam.example.com')).map(entry => entry.action)).toEqual(['routing.block', 'routing.unblock']);
    const fee = await auditOf('api.example.com/v1/pools');
    expect(fee.map(entry => entry.action).sort()).toEqual(['routing.endpoint_fee', 'routing.endpoint_fee', 'routing.endpoint_register']);
  });
});
