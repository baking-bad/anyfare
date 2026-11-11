import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { endpoints } from '../src/agents/endpoints';
import { errorDocs } from '../src/agents/errors';
import { curlExamples } from '../src/agents/examples';
import { topupStates } from '../src/agents/topups';
import { readSettings } from '../src/config';

// The endpoint list, the error list and the top-up states checked against the source of the other packages,
// read as text. This is a text match, not a parse: it finds a route written as `.get('/path'` (a method call on the
// app or a scope, with or without a generic) or as `url: '/path'` (a public read, which answers GET), and a
// path held in a constant that the call names. It does not read the schemas or the answers: an answer that changed
// shape is not found here, a route that was renamed or removed, or never written, is.

const packages = fileURLToPath(new URL('../..', import.meta.url));

const sourceFiles = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = `${directory}/${name}`;

  return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
});

const sourceOf = (name: string): { readonly path: string; readonly text: string }[] =>
  sourceFiles(`${packages}/${name}/src`).map(path => ({ path, text: readFileSync(path, 'utf8') }));

const sources = { api: sourceOf('api'), proxy: sourceOf('proxy') };
const everything = [...sources.api, ...sources.proxy, ...sourceOf('core'), ...sourceOf('payments')].map(file => file.text).join('\n');

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'ANY';

interface Route {
  readonly method: Method;
  readonly path: string;
}

// The names of the constants that hold a path: `const keyPath = '/_/key'`
const constantsOf = (text: string): Map<string, string> =>
  new Map([...text.matchAll(/const (\w+) = '(\/[^']*)'/g)].map(match => [match[1]!, match[2]!]));

// Every route a file registers
const routesOf = (text: string): Route[] => {
  const constants = constantsOf(text);
  const resolve = (token: string): string | undefined => token.startsWith('\'') ? token.slice(1, -1) : constants.get(token);
  const routes: Route[] = [];
  for (const match of text.matchAll(/\.(get|post|put|patch|delete)(?:<[^()]*>)?\(\s*('[^']+'|\w+)\s*[,)]/g)) {
    const path = resolve(match[2]!);
    if (path?.startsWith('/'))
      routes.push({ method: match[1]!.toUpperCase() as Method, path });
  }
  for (const match of text.matchAll(/url:\s*'(\/[^']*)'/g)) {
    // A route made with `url:` takes the public read methods, or every routed method
    if (text.includes('publicReadMethods'))
      routes.push({ method: 'GET', path: match[1]! });
    else if (text.includes('routedMethods'))
      routes.push({ method: 'ANY', path: match[1]! });
  }

  return routes;
};

const routes = {
  api: sources.api.flatMap(file => routesOf(file.text)),
  proxy: sources.proxy.flatMap(file => routesOf(file.text)),
};

describe('the endpoint list against the code', () => {
  it.each(endpoints.map(endpoint => [`${endpoint.method} ${endpoint.host} ${endpoint.path}`, endpoint] as const))('%s is a route the code registers', (_name, endpoint) => {
    const { method, path } = endpoint.source;
    const registered = routes[endpoint.source.package].some(route => route.method === method && route.path === path);
    expect(registered, `no ${method} ${path} in packages/${endpoint.source.package}/src`).toBe(true);
  });

  it('puts each endpoint on the host of the package that registers it', () => {
    for (const endpoint of endpoints)
      expect(endpoint.source.package).toBe(endpoint.host === 'pay' ? 'proxy' : 'api');
  });

  it('writes a path the way the code does: the path a person sees is the route, but for the parts they fill in', () => {
    for (const endpoint of endpoints) {
      const shown = endpoint.path.split('?')[0]!;
      // The parts a person fills in: `:id` and `<host>` for the code's `:id` and `*`
      const shape = (path: string): string => path.replace(/:\w+|<\w+>|\*/g, '{}');
      if (endpoint.id === 'routed')
        expect(shown).toBe('/<host>/<path>');
      else
        expect(shape(shown)).toBe(shape(endpoint.source.path));
    }
  });

  it('lists every public route the code registers: a new route is added to the list', () => {
    const listed = new Set(endpoints.map(endpoint => `${endpoint.source.package} ${endpoint.source.method} ${endpoint.source.path}`));
    for (const name of ['api', 'proxy'] as const) {
      const registered = [...new Set(routes[name].filter(route => route.path.startsWith('/v1/') || route.path.startsWith('/_/')).map(route => `${name} ${route.method} ${route.path}`))];
      const missing = registered.filter(route => !listed.has(route));
      expect(missing, 'routes the code registers that the list does not have').toEqual([]);
    }
  });

  it('finds routes at all: the match is not empty', () => {
    expect(routes.api.length).toBeGreaterThan(20);
    expect(routes.proxy.length).toBeGreaterThan(3);
    expect(routes.api).toContainEqual({ method: 'POST', path: '/v1/keys' });
    expect(routes.proxy).toContainEqual({ method: 'GET', path: '/_/key' });
  });
});

describe('the examples against the code', () => {
  it('call an endpoint of the list, with its method and path', () => {
    const settings = readSettings({});
    for (const example of curlExamples(settings)) {
      const target = example.url.slice(example.url.startsWith(settings.apiUrl) ? settings.apiUrl.length : settings.payUrl.length).split('?')[0]!;
      const endpoint = endpoints.find(candidate => candidate.example === example.id || candidate.alsoExamples?.includes(example.id));
      expect(endpoint, example.id).toBeDefined();
      expect(endpoint!.method === 'SSE' ? 'GET' : endpoint!.method === 'ANY' ? example.method : endpoint!.method).toBe(example.method);
      // The address with its variables read as the path's parts
      const pattern = new RegExp(`^${escape(endpoint!.path.split('?')[0]!).replace(/:\w+/g, '[^/]+').replace('<host>/<path>', '.+')}$`);
      expect(target.replace(/\$[A-Z_]+/g, 'x'), example.id).toMatch(pattern);
    }
  });

  it('expect fields the code names', () => {
    for (const example of curlExamples(readSettings({}))) {
      for (const field of example.expect.fields)
        expect(new RegExp(`\\b${field}\\b`).test(everything), `${example.id}: ${field}`).toBe(true);
    }
  });
});

describe('the error list against the code', () => {
  it.each(errorDocs.map(error => [error.code, error] as const))('%s is a code the code answers', (code, error) => {
    expect(new RegExp(`'${code}'|\\b${code}: \\d{3}`).test(everything), code).toBe(true);
    // Its status is the one the code's table gives, in the host's own table or its payments'
    const tables = [...sources.api, ...sources.proxy].filter(file => /errorStatuses = \{/.test(file.text)).map(file => file.text);
    const row = tables.map(table => new RegExp(`\\b${code}: (\\d{3})`).exec(table)?.[1]).find(status => status !== undefined);
    if (row !== undefined)
      expect(Number(row)).toBe(error.status);
  });
});

describe('the top-up states against the code', () => {
  it('are the code\'s list, in the same words, and a state is final when the code stops polling it', () => {
    const core = readFileSync(`${packages}/core/src/topups.ts`, 'utf8');
    const listed = /topupStatuses = \[([\s\S]*?)\] as const/.exec(core)![1]!.match(/'(\w+)'/g)!.map(item => item.slice(1, -1));
    const open = /openTopupStatuses = \[([\s\S]*?)\] as const/.exec(core)![1]!.match(/'(\w+)'/g)!.map(item => item.slice(1, -1));
    expect(topupStates.map(state => state.status).sort()).toEqual([...listed].sort());
    // Open: the job still polls it. Final: it doesn't. `quoting` is a moment before the address is made.
    for (const state of topupStates)
      expect(state.final, state.status).toBe(!open.includes(state.status) && state.status !== 'quoting');
  });
});
