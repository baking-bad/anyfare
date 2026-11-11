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
    expect(block('[1,{"n":12345678901234567890123,"s":"a\\u001b[31m\\"b"},[],{}]', 'text/plain')).toEqual([
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

  it('shows 40 lines, then how many more, or all of them with --full', () => {
    const body = Array.from({ length: 45 }, (_, at) => `line ${at + 1}`).join('\n');
    const lines = block(body, 'text/plain');
    expect(lines).toHaveLength(1 + 40 + 1);
    expect(lines[40]).toBe(' │ line 40');
    expect(lines[41]).toBe(' │ … 5 more lines');
    expect(block(Array.from({ length: 41 }, () => 'x').join('\n'), 'text/plain').at(-1)).toBe(' │ … 1 more line');
    expect(block(body, 'text/plain', true)).toHaveLength(1 + 45);
    expect(block(Array.from({ length: 40 }, () => 'x').join('\n'), 'text/plain')).toHaveLength(41);
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
      expect(prettyLines(text, 40)).toBeUndefined();
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

  it('makes only the 40 lines it shows of a large body, and counts the rest, in linear time', () => {
    // Made up: half a million small objects, 9 MB
    const count = 500_000;
    const text = `[${'{"a":1,"b":"xyz"},'.repeat(count)}{}]`;
    const started = performance.now();
    const lines = block(text, 'application/json');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lines).toHaveLength(1 + 40 + 1);
    // Each object is 4 lines; the list's brackets and the last {} are 3 more
    expect(lines.at(-1)).toBe(` │ … ${4 * count + 3 - 40} more lines`);
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
    expect(lines.at(-1)).toBe(' │ … 199961 more lines');
  });
});
