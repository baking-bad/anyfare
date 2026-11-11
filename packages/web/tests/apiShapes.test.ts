import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { endpoints as agentEndpoints } from '../src/agents/endpoints';
import { errorDocs } from '../src/agents/errors';
import { checkMethods, refusalDetails } from '../src/check/content';

// The website's types against the API's response schemas, both read as text: nothing of another package is
// imported. For each response schema a page reads, the website's type for that endpoint must know every
// property the schema names, and the schema must know every property of the type. A new field in the API
// fails this until the website's types know it.
//
// How exact it is:
// - The top level is exact: the schema's properties are the type's own members, no more and no fewer.
// - Below the top level the match is by name, over the whole endpoint: every property name at any depth of the
//   schema is a member (or a literal key, such as `7d`) somewhere in the type and the types it names, and every
//   member of those is a property of the schema. A name that is in two objects is not told apart.
// - Whether a value can be `null` is checked the same way, by name: a name that is nullable in the schema is
//   nullable in the type, and the other way round.
// - A property's own kind (a string, a number, a list) and an enum's values are not compared.

const packages = fileURLToPath(new URL('../..', import.meta.url));
const apiSource = (path: string): string => readFileSync(`${packages}/api/src/${path}`, 'utf8');
const webTypes = readFileSync(fileURLToPath(new URL('../src/api/types.ts', import.meta.url)), 'utf8');

const opens = '{[(<';
const closes = '}])>';

/** The text without comments, and with the inside of every string blanked (its quotes stay). */
const plain = (text: string, keepStrings = false): string => {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n')
        index += 1;
      out += '\n';
    }
    else if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index + 2) + 1;
    }
    else if (char === '\'' || char === '"' || char === '`') {
      let end = index + 1;
      while (end < text.length && text[end] !== char)
        end += text[end] === '\\' ? 2 : 1;
      // Kept strings lose the characters that would read as brackets or separators
      out += keepStrings ? text.slice(index, end + 1).replace(/[{}[\]()<>,;]/g, '_') : `${char}${' '.repeat(Math.max(0, end - index - 1))}${char}`;
      index = end;
    }
    else {
      out += char;
    }
  }

  return out;
};

/** Splits at a separator that is not inside a bracket. `=>` is no bracket. */
const splitTop = (text: string, separator: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '=' && text[index + 1] === '>') {
      index += 1;
      continue;
    }
    if (opens.includes(char))
      depth += 1;
    else if (closes.includes(char))
      depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));

  return parts.map(part => part.trim()).filter(part => part !== '');
};

/** The text inside the bracket that opens at `from`. */
const inside = (text: string, from: number): string => {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    // An arrow is no bracket
    if (char === '=' && text[index + 1] === '>') {
      index += 1;
      continue;
    }
    if (opens.includes(char))
      depth += 1;
    else if (closes.includes(char)) {
      depth -= 1;
      if (depth === 0)
        return text.slice(from + 1, index);
    }
  }

  return text.slice(from + 1);
};

// ---------- The API's schemas ----------

type Shape =
  | { readonly kind: 'leaf'; readonly nullable: boolean }
  | { readonly kind: 'object'; readonly nullable: boolean; readonly props: ReadonlyMap<string, Shape> }
  | { readonly kind: 'array'; readonly item: Shape };

/** The `const name = expression` definitions of a file, by name. */
const constantsOf = (source: string): Map<string, string> => {
  const text = plain(source, true);
  const found = new Map<string, string>();
  for (const match of text.matchAll(/^(?:export )?const (\w+)\s*=\s*/gm)) {
    const from = match.index + match[0].length;
    const end = splitTop(text.slice(from), ';')[0] ?? '';
    found.set(match[1]!, end.replace(/\s+as const$/, '').trim());
  }

  return found;
};

const periodKeys = ['today', '7d', '30d', 'all'];

const propsOf = (body: string, constants: ReadonlyMap<string, string>): Map<string, Shape> => {
  const props = new Map<string, Shape>();
  for (const entry of splitTop(body, ',')) {
    if (entry.startsWith('...'))
      continue;
    const match = /^(?:'([^']+)'|(\w+))\s*(?::([\s\S]*))?$/.exec(entry);
    if (!match)
      continue;
    const name = match[1] ?? match[2]!;
    props.set(name, match[3] === undefined ? shapeOf(name, constants) : shapeOf(match[3].trim(), constants));
  }

  return props;
};

const shapeOf = (expression: string, constants: ReadonlyMap<string, string>): Shape => {
  const call = /^(\w+)\(/.exec(expression);
  if (call?.[1] === 'object')
    return { kind: 'object', nullable: false, props: propsOf(inside(inside(expression, expression.indexOf('(')), 0), constants) };
  if (call?.[1] === 'list')
    return { kind: 'array', item: shapeOf(inside(expression, expression.indexOf('(')), constants) };
  if (call?.[1] === 'byPeriod') {
    const value = inside(expression, expression.indexOf('('));

    return { kind: 'object', nullable: false, props: new Map(periodKeys.map(key => [key, shapeOf(value, constants)])) };
  }
  if (call?.[1] === 'nullable')
    return { kind: 'leaf', nullable: true };
  if (expression.startsWith('{')) {
    const entries = splitTop(inside(expression, 0), ',');
    const valueOf = (name: string): string | undefined => entries.find(entry => entry.startsWith(`${name}:`))?.slice(name.length + 1).trim();
    const nullable = /^\[[^\]]*'null'/.test(valueOf('type') ?? '');
    const items = valueOf('items');
    if (items !== undefined)
      return { kind: 'array', item: shapeOf(items, constants) };
    const properties = valueOf('properties');
    if (properties !== undefined)
      return { kind: 'object', nullable, props: propsOf(inside(properties, 0), constants) };

    return { kind: 'leaf', nullable };
  }
  if (/^\w+$/.test(expression) && constants.has(expression) && constants.get(expression) !== expression)
    return shapeOf(constants.get(expression)!, constants);

  return { kind: 'leaf', nullable: false };
};

interface Facts {
  // The properties of the schema itself
  readonly top: readonly string[];
  // Every property name at any depth
  readonly names: ReadonlySet<string>;
  readonly nullable: ReadonlySet<string>;
}

const factsOf = (shape: Shape): Facts => {
  const names = new Set<string>();
  const nullable = new Set<string>();
  const walk = (node: Shape): void => {
    if (node.kind === 'array')
      walk(node.item);
    else if (node.kind === 'object') {
      for (const [name, child] of node.props) {
        names.add(name);
        if (child.kind !== 'array' && child.nullable)
          nullable.add(name);
        walk(child);
      }
    }
  };
  walk(shape);
  const top = shape.kind === 'object' ? [...shape.props.keys()] : shape.kind === 'array' && shape.item.kind === 'object' ? [...shape.item.props.keys()] : [];

  return { top, names, nullable };
};

export const schemaFacts = (source: string, name: string): Facts => {
  const constants = constantsOf(source);
  const expression = constants.get(name);
  if (expression === undefined)
    throw new Error(`No schema ${name}`);

  return factsOf(shapeOf(expression, constants));
};

// ---------- The website's types ----------

interface Member {
  readonly name: string;
  readonly nullable: boolean;
}

const declarationsOf = (source: string): Map<string, string> => {
  const text = plain(source, true);
  const found = new Map<string, string>();
  for (const match of text.matchAll(/^export (?:interface|type) (\w+)/gm)) {
    const from = match.index + match[0].length;
    const rest = text.slice(from);
    const brace = /^\s*(?:<[^>]*>)?\s*(?:extends [^{]*)?\{/.exec(rest);
    const body = brace ? inside(rest, brace[0].length - 1) : (splitTop(rest.slice(rest.indexOf('=') + 1), ';')[0] ?? '');
    found.set(match[1]!, body);
  }

  return found;
};

/** The members of an object type's text, and of every object type inside it. */
const membersOf = (body: string): Member[] => splitTop(body, ';').flatMap(entry => {
  const match = /^(?:readonly\s+)?(?:'([^']+)'|(\w+))(\?)?\s*:([\s\S]*)$/.exec(entry);
  if (!match)
    return [];
  const type = match[4]!;
  let outside = '';
  const nested: Member[] = [];
  for (let index = 0; index < type.length; index += 1) {
    if (type[index] === '{') {
      const group = inside(type, index);
      nested.push(...membersOf(group));
      index += group.length + 1;
    }
    else {
      outside += type[index];
    }
  }

  return [{ name: match[1] ?? match[2]!, nullable: match[3] === '?' || /\bnull\b/.test(outside) }, ...nested];
});

interface Known {
  readonly top: readonly string[];
  readonly names: ReadonlySet<string>;
  readonly literals: ReadonlySet<string>;
  readonly nullable: ReadonlySet<string>;
}

/** What the website's type `name` and the types it names say about its properties. */
export const typeFacts = (source: string, name: string): Known => {
  const declarations = declarationsOf(source);
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next) || !declarations.has(next))
      continue;
    seen.add(next);
    for (const word of declarations.get(next)!.match(/\b[A-Z]\w*/g) ?? [])
      queue.push(word);
  }
  const bodies = [...seen].map(declaration => declarations.get(declaration)!);
  const members = bodies.flatMap(membersOf);
  const own = membersOf(declarations.get(name)!);
  const ownTop = splitTop(declarations.get(name)!, ';').flatMap(entry => {
    const match = /^(?:readonly\s+)?(?:'([^']+)'|(\w+))\??\s*:/.exec(entry);

    return match ? [match[1] ?? match[2]!] : [];
  });

  return {
    top: ownTop.length > 0 ? ownTop : own.map(member => member.name),
    names: new Set(members.map(member => member.name)),
    literals: new Set(bodies.flatMap(body => [...body.matchAll(/'([^']+)'/g)].map(match => match[1]!))),
    nullable: new Set(members.filter(member => member.nullable).map(member => member.name)),
  };
};

/** What differs between a schema and a type, in words. Empty when they agree. */
export const differences = (schema: Facts, type: Known): string[] => {
  const problems: string[] = [];
  const sorted = (names: Iterable<string>): string[] => [...names].sort();
  const missingTop = schema.top.filter(name => !type.top.includes(name));
  const extraTop = type.top.filter(name => !schema.top.includes(name));
  if (missingTop.length > 0)
    problems.push(`the type does not have ${sorted(missingTop).join(', ')} at its top`);
  if (extraTop.length > 0)
    problems.push(`the schema does not have ${sorted(extraTop).join(', ')} at its top`);
  const missing = sorted(schema.names).filter(name => !type.names.has(name) && !type.literals.has(name));
  if (missing.length > 0)
    problems.push(`the type does not know ${missing.join(', ')}`);
  const extra = sorted(type.names).filter(name => !schema.names.has(name));
  if (extra.length > 0)
    problems.push(`the schema does not have ${extra.join(', ')}`);
  const canBeNull = sorted(schema.nullable).filter(name => !type.nullable.has(name));
  if (canBeNull.length > 0)
    problems.push(`the type does not allow null for ${canBeNull.join(', ')}`);
  const neverNull = sorted(type.nullable).filter(name => !schema.nullable.has(name));
  if (neverNull.length > 0)
    problems.push(`the type allows null for ${neverNull.join(', ')}, which the schema never gives as null`);

  return problems;
};

// Each response schema the website reads, the file it is in, and the website's type for it
const endpoints = [
  { route: 'GET /v1/calls', file: 'calls/schemas.ts', schema: 'listResponseSchema', type: 'CallsPage' },
  { route: 'a call (list, stream)', file: 'calls/schemas.ts', schema: 'callSchema', type: 'Call' },
  { route: 'GET /v1/calls/:id', file: 'calls/schemas.ts', schema: 'receiptSchema', type: 'Receipt' },
  { route: 'GET /v1/stats', file: 'stats/schemas.ts', schema: 'platformSchema', type: 'Stats' },
  { route: 'GET /v1/stats/live', file: 'stats/schemas.ts', schema: 'liveSchema', type: 'LiveStats' },
  { route: 'GET /v1/stats/top', file: 'stats/schemas.ts', schema: 'topSchema', type: 'TopStats' },
  { route: 'GET /v1/services', file: 'stats/schemas.ts', schema: 'servicesSchema', type: 'ServicesPage' },
  { route: 'GET /v1/services/:host', file: 'stats/schemas.ts', schema: 'serviceSchema', type: 'ServiceDetail' },
  { route: 'GET /v1/endpoints/stats', file: 'stats/schemas.ts', schema: 'endpointSchema', type: 'EndpointStats' },
] as const;

describe('the website\'s types against the API\'s response schemas', () => {
  it.each(endpoints.map(endpoint => [endpoint.route, endpoint] as const))('%s: the type knows exactly what the schema names', (_route, endpoint) => {
    const schema = schemaFacts(apiSource(endpoint.file), endpoint.schema);
    const type = typeFacts(webTypes, endpoint.type);

    expect(schema.top.length, 'the schema was found and has properties').toBeGreaterThan(3);
    expect(differences(schema, type)).toEqual([]);
  });

  it('reads the schemas well: it finds the fields it is known to find', () => {
    const stats = schemaFacts(apiSource('stats/schemas.ts'), 'platformSchema');
    expect(stats.top).toEqual(['updatedAt', 'allUpdatedAt', 'calls', 'volume', 'buyers', 'services', 'byPaidWith', 'topups', 'daily']);
    expect(stats.names).toContain('7d');
    expect(stats.names).toContain('usd');
    expect([...stats.nullable]).toEqual(['updatedAt', 'allUpdatedAt']);
    const receipt = schemaFacts(apiSource('calls/schemas.ts'), 'receiptSchema');
    expect(receipt.names).toContain('settledAt');
    expect(receipt.names).toContain('payTo');
    expect(receipt.nullable).toContain('api');
    expect(receipt.nullable).toContain('fee');
    const service = schemaFacts(apiSource('stats/schemas.ts'), 'serviceSchema');
    expect(service.names).toContain('exact');
    expect(service.names).toContain('lastCallAt');
    expect(service.nullable).toContain('priceNow');
    expect(service.nullable).not.toContain('updatedAt');
  });

  it('fails when the API gains a field, loses one, or makes one nullable, until the website follows', () => {
    const stats = apiSource('stats/schemas.ts');
    const type = typeFacts(webTypes, 'ServiceDetail');
    const schema = (text: string) => schemaFacts(text, 'serviceSchema');

    expect(differences(schema(stats), type)).toEqual([]);
    const added = stats.replace('  exact: { type: \'boolean\' },\n});\n\nexport const endpointSchema', '  exact: { type: \'boolean\' },\n  newField: string,\n});\n\nexport const endpointSchema');
    expect(added).not.toBe(stats);
    expect(differences(schema(added), type)).toEqual(['the type does not have newField at its top', 'the type does not know newField']);
    const removed = stats.replace('  paidEndpoints: integer,\n  stats: object({\n    calls: integer,\n    callsBefore', '  stats: object({\n    calls: integer,\n    callsBefore');
    expect(removed).not.toBe(stats);
    expect(differences(schema(removed), type).join(' ')).toContain('the schema does not have paidEndpoints');
    const nullable = stats.replace('  updatedAt: time,\n  status: listedStatus', '  updatedAt: nullableTime,\n  status: listedStatus');
    expect(nullable).not.toBe(stats);
    expect(differences(schema(nullable), type)).toEqual(['the type does not allow null for updatedAt']);
  });
});

// The pay host's check, `GET /_/check`: its response schema is in the proxy's source, read as text the same way
const checkSource = readFileSync(`${packages}/proxy/src/routing/check.ts`, 'utf8');
const answerTypes = readFileSync(fileURLToPath(new URL('../src/check/answer.ts', import.meta.url)), 'utf8');

describe('the website\'s types against the pay host\'s check', () => {
  it.each([
    ['a payable link', 'payableSchema', 'PayableAnswer'],
    ['a link it won\'t quote', 'refusedSchema', 'RefusedAnswer'],
  ] as const)('%s: the type knows exactly what the schema names', (_name, schemaName, typeName) => {
    const schema = schemaFacts(checkSource, schemaName);
    const type = typeFacts(answerTypes, typeName);

    expect(schema.top.length, 'the schema was found and has properties').toBeGreaterThan(3);
    expect(differences(schema, type)).toEqual([]);
  });

  it('reads the check\'s schema well: the fields and the nulls it is known to have', () => {
    const payable = schemaFacts(checkSource, 'payableSchema');
    expect(payable.top).toEqual(['payable', 'method', 'target', 'price', 'quote', 'link', 'protocol', 'asks', 'upstream', 'payWith', 'stats', 'listed', 'checkedAt', 'ms']);
    expect([...payable.nullable].sort()).toEqual(['network', 'p50Ms', 'stats', 'successRate']);
    expect(payable.names).toContain('mpp');
    const refused = schemaFacts(checkSource, 'refusedSchema');
    expect(refused.top).toEqual(['payable', 'method', 'reason', 'message', 'detail', 'upstream']);
  });

  it('knows every detail the check can give, and takes only methods the check takes', () => {
    const details = /export type CheckDetail =([\s\S]*?);\n/.exec(checkSource)?.[1]?.match(/'(\w+)'/g)?.map(word => word.slice(1, -1)) ?? [];
    const methods = /export const checkMethods = \[([^\]]*)\]/.exec(checkSource)?.[1]?.match(/'(\w+)'/g)?.map(word => word.slice(1, -1)) ?? [];
    const worded = refusalDetails.flatMap(([, list]) => list);

    expect(details.length).toBeGreaterThan(10);
    // Every detail the pay host gives is worded; the website may word one the pay host doesn't give yet
    for (const detail of details)
      expect(worded, detail).toContain(detail);
    for (const method of checkMethods)
      expect(methods, method).toContain(method);
    expect(checkSource).toMatch(/method: \{ type: 'string', enum: \[\.\.\.checkMethods\], default: 'GET' \}/);
  });
});

describe('the agent files against the API\'s response schemas', () => {
  const documented = [
    { id: 'catalog', file: 'catalog/routes.ts', schema: 'catalogSchema' },
    { id: 'calls', file: 'calls/schemas.ts', schema: 'listResponseSchema' },
    { id: 'receipt', file: 'calls/schemas.ts', schema: 'receiptSchema' },
    { id: 'stats', file: 'stats/schemas.ts', schema: 'platformSchema' },
    { id: 'stats-live', file: 'stats/schemas.ts', schema: 'liveSchema' },
    { id: 'stats-top', file: 'stats/schemas.ts', schema: 'topSchema' },
    { id: 'services', file: 'stats/schemas.ts', schema: 'servicesSchema' },
    { id: 'service', file: 'stats/schemas.ts', schema: 'serviceSchema' },
    { id: 'endpoint-stats', file: 'stats/schemas.ts', schema: 'endpointSchema' },
  ] as const;

  it.each(documented.map(entry => [entry.id, entry] as const))('the example answer of %s has the schema\'s top-level fields, no more and no fewer', (_id, entry) => {
    const endpoint = agentEndpoints.find(candidate => candidate.id === entry.id)!;
    const json = endpoint.answer.json as Record<string, unknown>;

    expect(Object.keys(json).sort()).toEqual([...schemaFacts(apiSource(entry.file), entry.schema).top].sort());
  });

  it('shows a catalog endpoint with the fields the schema names, and its cursor and partial flag', () => {
    const schema = schemaFacts(apiSource('catalog/routes.ts'), 'catalogSchema');
    expect(schema.top).toEqual(['endpoints', 'next', 'partial']);
    expect([...schema.nullable]).toEqual(['next']);
    const json = agentEndpoints.find(candidate => candidate.id === 'catalog')!.answer.json as { endpoints: Record<string, unknown>[]; next: unknown; partial: unknown };
    const entry = [...schema.names].filter(name => !schema.top.includes(name));

    expect(json.endpoints.length).toBeGreaterThan(0);
    expect(Object.keys(json.endpoints[0]!).sort()).toEqual(entry.sort());
    expect(json.next).toBeNull();
    expect(typeof json.partial).toBe('boolean');
  });

  it('lists the error codes the public reads answer with, and the stream\'s', () => {
    const codes = new Set(errorDocs.map(error => error.code));
    expect(codes.has('stats_unavailable')).toBe(true);
    expect(codes.has('shutting_down')).toBe(true);
    const answers = (id: string): readonly string[] => agentEndpoints.find(candidate => candidate.id === id)!.errors;
    for (const id of ['catalog', 'stats-live', 'service', 'endpoint-stats'])
      expect(answers(id), id).toContain('503 stats_unavailable');
    expect(answers('calls-stream')).toContain('503 shutting_down');
    // The two names the code gives them
    expect(apiSource('errors.ts')).toMatch(/shutting_down: 503/);
    expect(apiSource('errors.ts')).toMatch(/stats_unavailable: 503/);
  });

  it('says the calls and the stream take the exact `host` as well as `service`', () => {
    for (const id of ['calls', 'calls-stream']) {
      const request = agentEndpoints.find(candidate => candidate.id === id)!.request!.join(' ');
      expect(request, id).toContain('`host`');
      expect(request, id).toContain('`service`');
    }
    expect(apiSource('calls/schemas.ts')).toMatch(/\bhost: \{/);
  });
});
