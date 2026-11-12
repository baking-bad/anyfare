// The result block. Every answer here is made up.

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, cleanLine, mediaType, prettyJson, prettyLines, resultBlock, textLines } from '../src/result.ts';
import { createStyle } from '../src/style.ts';

// Not a terminal: no colors
const style = createStyle(new Writable({ write: (_chunk, _encoding, done) => done() }));

const answer = (body: string | Uint8Array, contentType: string | null = 'application/json', status = 200) => ({
  status,
  headers: new Headers(contentType === null ? {} : { 'content-type': contentType }),
  bytes: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  ms: 2_140,
});
const block = (body: string | Uint8Array, contentType?: string | null, full = false) => resultBlock(style, answer(body, contentType), { full });

describe('the result block', () => {
  it('has a header with the status, the media type without its parameters, and the time', () => {
    expect(block('{"a":1}', 'application/json; charset=utf-8')).toEqual([' Result · HTTP 200 · application/json · 2.1 s', ' │ {', ' │   "a": 1', ' │ }']);
    expect(resultBlock(style, answer('x', null, 404), { full: false })[0]).toBe(' Result · HTTP 404 · no content type · 2.1 s');
  });

  it('pretty-prints JSON found by parsing, and keeps every digit and escape of it', () => {
    // With --full: a list of 4 items is otherwise folded
    expect(block('[1,{"n":12345678901234567890123,"s":"a\\u001b[31m\\"b"},[],{}]', 'text/plain', true)).toEqual([
      ' Result · HTTP 200 · text/plain · 2.1 s',
      ' │ [',
      ' │   1,',
      ' │   {',
      ' │     "n": 12345678901234567890123,',
      ' │     "s": "a\\u001b[31m\\"b"',
      ' │   },',
      ' │   [],',
      ' │   {}',
      ' │ ]',
    ]);
  });

  it('writes JSON as JSON.stringify does with 2 spaces', () => {
    const value = { a: [1, 2, { b: null, c: [] }], d: 'e, f: g', h: { i: true } };
    expect(prettyJson(JSON.stringify(value))).toBe(JSON.stringify(value, null, 2));
    expect(prettyJson(' {\n "a" :\t[ 1 , 2 ] }\r\n')).toBe(JSON.stringify({ a: [1, 2] }, null, 2));
    expect(prettyJson('not json')).toBeUndefined();
  });

  it('shows other text as it is, without its last line break', () => {
    expect(block('one\r\ntwo\n\n', 'text/csv')).toEqual([' Result · HTTP 200 · text/csv · 2.1 s', ' │ one', ' │ two']);
    expect(block('<a>b</a>', 'application/xml').slice(1)).toEqual([' │ <a>b</a>']);
  });

  it('shows 80 lines, then how many more, or all of them with --full', () => {
    const body = Array.from({ length: 85 }, (_, at) => `line ${at + 1}`).join('\n');
    const lines = block(body, 'text/plain');
    expect(lines).toHaveLength(1 + 80 + 1);
    expect(lines[80]).toBe(' │ line 80');
    expect(lines[81]).toBe(' │ … 5 more lines');
    expect(block(Array.from({ length: 81 }, () => 'x').join('\n'), 'text/plain').at(-1)).toBe(' │ … 1 more line');
    expect(block(body, 'text/plain', true)).toHaveLength(1 + 85);
    expect(block(Array.from({ length: 80 }, () => 'x').join('\n'), 'text/plain')).toHaveLength(81);
  });

  it('cuts a line at 200 characters, by code point, or shows it whole with --full', () => {
    const long = 'é'.repeat(150) + '😀'.repeat(100);
    const [, line] = block(long, 'text/plain');
    expect(line).toBe(` │ ${'é'.repeat(150)}${'😀'.repeat(50)}…`);
    expect(block(long, 'text/plain', true)[1]).toBe(` │ ${long}`);
    expect(block('x'.repeat(200), 'text/plain')[1]).toBe(` │ ${'x'.repeat(200)}`);
  });

  it('strips control characters, and makes a tab two spaces', () => {
    const [, line] = block('a\u001b[31mred\u001b[0m\rb\u0007c\td\u0000e\u009bf\u202eg\u2028h', 'text/plain');
    expect(line).toBe(' │ a[31mred[0mbc  def' + 'gh');
    expect(cleanLine('\u001b]0;title\u0007')).toBe(']0;title');
  });

  it('does not show a body that is not text', () => {
    expect(block(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]), 'image/png').slice(1)).toEqual([' │ 6 bytes of image/png, not shown']);
    expect(block(new Uint8Array([0xff, 0xfe, 0]), null).slice(1)).toEqual([' │ 3 bytes of unknown type, not shown']);
    expect(block('plain words', null).slice(1)).toEqual([' │ plain words']);
  });

  it('says an empty body is empty', () => {
    expect(block('', 'application/json').slice(1)).toEqual([' │ (empty)']);
  });

  it('adds the proof rows, labels padded to 14', () => {
    const lines = resultBlock(style, answer('{}'), { full: false, proof: [['Transaction', 'MadeUpHash'], ['Payer', 'alice.near']] });
    expect(lines.slice(2)).toEqual([' Proof', ' │ Transaction   MadeUpHash', ' │ Payer         alice.near']);
  });

  it("cleans the media type, the API's own text", () => {
    expect(mediaType('text/\u001b[2Jplain; charset=x')).toBe('text/[2Jplain');
    expect(mediaType(null)).toBeUndefined();
    expect(mediaType(' ; x')).toBeUndefined();
  });
});

describe('a body that is hard to show', () => {
  it('shows JSON nested deeper than 64 as its own text, at once', () => {
    for (const depth of [MAX_DEPTH + 1, 20_000, 1_000_000]) {
      const text = `${'['.repeat(depth)}1${']'.repeat(depth)}`;
      const started = performance.now();
      // Its own text, on one line, cut at 200 characters
      expect(block(text, 'application/json').slice(1)).toEqual([text.length > 200 ? ` │ ${'['.repeat(200)}…` : ` │ ${text}`]);
      expect(prettyLines(text, 80)).toBeUndefined();
      expect(prettyLines(text, 80, true)).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });

  it('indents JSON nested 64 deep', () => {
    const text = `${'['.repeat(MAX_DEPTH)}1${']'.repeat(MAX_DEPTH)}`;
    const pretty = prettyLines(text, Number.POSITIVE_INFINITY);
    expect(pretty?.lines[MAX_DEPTH]).toBe(`${'  '.repeat(MAX_DEPTH)}1`);
    expect(pretty?.total).toBe(2 * MAX_DEPTH + 1);
    expect(prettyJson(text)).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });

  it('makes only the 80 lines it shows of a large body, and counts the rest, in linear time', () => {
    // Made up: half a million small objects, 9 MB
    const count = 500_000;
    const text = `[${'{"a":1,"b":"xyz"},'.repeat(count)}{}]`;
    const started = performance.now();
    // Unfolded, as with --full, but with the limit
    const lines = prettyLines(text, 80);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lines?.lines).toHaveLength(80);
    // Each object is 4 lines; the list's brackets and the last {} are 3 more
    expect(lines?.total).toBe(4 * count + 3);
  });

  it('cuts a large object at 80 lines, and counts the rest, in linear time', () => {
    // Made up: half a million keys, about 10 MB. An object is never folded.
    const count = 500_000;
    const text = `{${Array.from({ length: count }, (_, at) => `"k${at}":{"a":1}`).join(',')}}`;
    const started = performance.now();
    const lines = block(text, 'application/json');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lines).toHaveLength(1 + 80 + 1);
    // Each key is 3 lines; the braces are 2 more
    expect(lines.at(-1)).toBe(` │ … ${3 * count + 2 - 80} more lines`);
  });

  it('gives the same lines and count with a limit as without', () => {
    const value = { a: [1, 2, { b: null, c: [[], {}] }], d: 'e, "f": [g]', h: { i: true } };
    const text = JSON.stringify(value);
    const whole = JSON.stringify(value, null, 2).split('\n');
    for (const limit of [0, 1, 5, whole.length, 100]) {
      expect(prettyLines(text, limit)).toEqual({ lines: whole.slice(0, limit), total: whole.length });
    }
    expect(textLines('a\nb\nc', 2)).toEqual({ lines: ['a', 'b'], total: 3 });
  });

  it('shows text that only looks like JSON as it is', () => {
    expect(block('[INFO] done]', 'text/plain').slice(1)).toEqual([' │ [INFO] done]']);
    expect(block('{"a": 1', 'application/json').slice(1)).toEqual([' │ {"a": 1']);
    expect(block(']]][[[', 'application/json').slice(1)).toEqual([' │ ]]][[[']);
  });

  it('drops line breaks at the end in linear time, however many there are', () => {
    const text = `${'\n'.repeat(200_000)}x${'\r\n'.repeat(200_000)}`;
    const started = performance.now();
    const lines = block(text, 'text/plain');
    expect(performance.now() - started).toBeLessThan(2_000);
    // 200000 empty lines and the x: the breaks after it are dropped
    expect(lines.at(-1)).toBe(' │ … 199921 more lines');
  });
});

/**
 * Made up, in the shape of CoinMarketCap's v3 quote: a list of one coin whose 39 tags, of 5 lines each,
 * come before its price. Every name, number and time here is made up.
 */
const COIN_QUOTE = {
  data: [
    {
      tags: Array.from({ length: 39 }, (_, at) => ({ slug: `made-up-tag-${at + 1}`, name: `Made-up tag ${at + 1}`, category: 'OTHERS' })),
      id: 1,
      name: 'Bitcoin',
      symbol: 'BTC',
      slug: 'bitcoin',
      num_market_pairs: 12_345,
      max_supply: 21_000_000,
      circulating_supply: 19_900_000,
      total_supply: 19_900_000,
      is_active: 1,
      infinite_supply: false,
      platform: null,
      cmc_rank: 1,
      is_fiat: 0,
      self_reported_circulating_supply: null,
      self_reported_market_cap: null,
      tvl_ratio: null,
      minted_market_cap: 1_472_600_000_000,
      last_updated: '2026-11-11T23:45:00.000Z',
      quote: [
        {
          symbol: 'USD',
          price: 74000.12,
          volume_24h: 41_000_000_000,
          volume_change_24h: 1.5,
          percent_change_1h: 0.1,
          percent_change_24h: -0.4,
          percent_change_7d: 2.3,
          percent_change_30d: 5.6,
          market_cap: 1_472_600_000_000,
          market_cap_dominance: 58.1,
          fully_diluted_market_cap: 1_554_000_000_000,
          tvl: null,
          last_updated: '2026-11-11T23:45:00.000Z',
          id: 2781,
        },
      ],
    },
  ],
  status: {
    timestamp: '2026-11-11T23:45:01.000Z',
    error_code: '0',
    error_message: 'SUCCESS',
    elapsed: 12,
    credit_count: 1,
    notice: null,
    total_count: 1,
    request_id: 'made-up-request',
  },
};

describe('a long JSON array', () => {
  it("shows a coin's price after its 39 tags: one tag, then how many more", () => {
    const lines = block(JSON.stringify(COIN_QUOTE));
    expect(lines.some((line) => line.endsWith('"price": 74000.12,'))).toBe(true);
    expect(lines.some((line) => line.includes('more line'))).toBe(false);
    expect(lines.slice(1, 13)).toEqual([
      ' │ {',
      ' │   "data": [',
      ' │     {',
      ' │       "tags": [',
      ' │         {',
      ' │           "slug": "made-up-tag-1",',
      ' │           "name": "Made-up tag 1",',
      ' │           "category": "OTHERS"',
      ' │         },',
      ' │         … 38 more items',
      ' │       ],',
      ' │       "id": 1,',
    ]);
    expect(lines.filter((line) => line.includes('made-up-tag-'))).toHaveLength(1);
  });

  it('shows all 39 tags with --full', () => {
    const lines = block(JSON.stringify(COIN_QUOTE), 'application/json', true);
    expect(lines.filter((line) => line.includes('made-up-tag-'))).toHaveLength(39);
    expect(lines.some((line) => line.includes('more item'))).toBe(false);
    expect(lines.slice(1)).toEqual(JSON.stringify(COIN_QUOTE, null, 2).split('\n').map((line) => ` │ ${line}`));
  });

  it('folds an array of scalars the same way, and not one of 3 items', () => {
    expect(block('[1,"two",null,true,5.5]').slice(1)).toEqual([' │ [', ' │   1,', ' │   … 4 more items', ' │ ]']);
    expect(block('[1,2,3]').slice(1)).toEqual([' │ [', ' │   1,', ' │   2,', ' │   3', ' │ ]']);
    expect(block('[{"a":1},{"a":2},{"a":3}]').slice(1)).toHaveLength(11);
    expect(block('{"a":[],"b":[[]],"c":[1,2,3,4]}').slice(1)).toEqual([
      ' │ {',
      ' │   "a": [],',
      ' │   "b": [',
      ' │     []',
      ' │   ],',
      ' │   "c": [',
      ' │     1,',
      ' │     … 3 more items',
      ' │   ]',
      ' │ }',
    ]);
  });

  it('folds nested arrays at every depth', () => {
    expect(block('{"a":[[1,2,3,4],[5],[6],[7]]}').slice(1)).toEqual([
      ' │ {',
      ' │   "a": [',
      ' │     [',
      ' │       1,',
      ' │       … 3 more items',
      ' │     ],',
      ' │     … 3 more items',
      ' │   ]',
      ' │ }',
    ]);
    // An array of 3 is whole, and a long array inside it is folded
    expect(block('[[1],["a","b","c","d","e"],[2]]').slice(1)).toEqual([
      ' │ [',
      ' │   [',
      ' │     1',
      ' │   ],',
      ' │   [',
      ' │     "a",',
      ' │     … 4 more items',
      ' │   ],',
      ' │   [',
      ' │     2',
      ' │   ]',
      ' │ ]',
    ]);
  });

  it('keeps commas and brackets inside strings out of the count', () => {
    expect(block('["a,b","[c]","d]","e"]').slice(1)).toEqual([' │ [', ' │   "a,b",', ' │   … 3 more items', ' │ ]']);
    expect(block('["a,b,c,d,e","f"]').slice(1)).toEqual([' │ [', ' │   "a,b,c,d,e",', ' │   "f"', ' │ ]']);
  });

  it('counts the lines past 80 of what is folded', () => {
    // Made up: 100 keys of 1 line each, each with a list of 50 items
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, at) => [`k${at}`, Array.from({ length: 50 }, () => at)]));
    const lines = block(JSON.stringify(value));
    expect(lines).toHaveLength(1 + 80 + 1);
    // Each key folds to 4 lines; the braces are 2 more
    expect(lines.at(-1)).toBe(` │ … ${4 * 100 + 2 - 80} more lines`);
    expect(lines.slice(1, 6)).toEqual([' │ {', ' │   "k0": [', ' │     0,', ' │     … 49 more items', ' │   ],']);
  });

  it('folds a large array in linear time', () => {
    // Made up: half a million small objects, 9 MB
    const count = 500_000;
    const text = `[${'{"a":1,"b":"xyz"},'.repeat(count)}{}]`;
    const started = performance.now();
    const lines = block(text, 'application/json');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lines.slice(1)).toEqual([' │ [', ' │   {', ' │     "a": 1,', ' │     "b": "xyz"', ' │   },', ` │   … ${count} more items`, ' │ ]']);
  });

  it('gives the same lines and count with a limit as without', () => {
    const text = JSON.stringify(COIN_QUOTE);
    const whole = prettyLines(text, Number.POSITIVE_INFINITY, true);
    for (const limit of [0, 1, 9, 10, 11, 40, 100]) {
      expect(prettyLines(text, limit, true)).toEqual({ lines: whole?.lines.slice(0, limit), total: whole?.total });
    }
  });

  it('shows JSON nested deeper than 64 as its own text, folded or not', () => {
    const text = `[1,2,3,4,${'['.repeat(MAX_DEPTH)}1${']'.repeat(MAX_DEPTH)}]`;
    expect(prettyLines(text, 80, true)).toBeUndefined();
    expect(block(text).slice(1)).toEqual([` │ ${text}`]);
  });
});
