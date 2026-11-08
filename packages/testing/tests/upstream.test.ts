import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAddressPolicy, OutboundHttp } from '@anyfare/common';

import { createFakeResolver, startFakeUpstream, type FakeResolver, type FakeUpstream } from '../src/index.js';

let upstream: FakeUpstream;
let resolver: FakeResolver;
let http: OutboundHttp;

beforeEach(async () => {
  upstream = await startFakeUpstream({ hosts: ['api.example.com'] });
  resolver = createFakeResolver({ 'api.example.com': '127.0.0.1' });
  http = new OutboundHttp({
    ownHosts: [], resolver, addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }), ca: upstream.ca,
  });
});

afterEach(async () => {
  await http.close();
  await upstream.close();
});

describe('the fake upstream', () => {
  it('answers over HTTPS with its certificate, and records the request', async () => {
    const response = await http.request({
      url: upstream.url('api.example.com', '/v1/items?page=2'),
      method: 'POST',
      headers: { 'x-custom': 'yes', 'content-type': 'text/plain' },
      body: 'hello',
      redirect: 'none',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(resolver.lookups).toEqual(['api.example.com']);
    expect(upstream.connections).toBe(1);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/items?page=2',
      headers: { 'x-custom': 'yes', 'content-type': 'text/plain' },
      servername: 'api.example.com',
    });
    expect(upstream.requests[0]?.body.toString()).toBe('hello');
  });

  it('replaces its answer with handle', async () => {
    upstream.handle((request, response) => {
      response.writeHead(201, { 'x-seen': request.path }).end('created');
    });
    const response = await http.request({ url: upstream.url('api.example.com', '/made'), redirect: 'none' });

    expect(response.status).toBe(201);
    expect(response.headers['x-seen']).toBe('/made');
    expect(await response.text()).toBe('created');
  });

  it('fails a name the resolver doesn\'t know', () => {
    return expect(resolver.resolve('unknown.example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });
});
