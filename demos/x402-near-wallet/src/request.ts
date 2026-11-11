// A request is a URL with curl's options. This file splits a typed line and reads those words.

import { UsageError } from './util.ts';

export interface HttpRequest {
  /** Upper case. */
  readonly method: string;
  /** As typed, after the URL check. */
  readonly url: string;
  /** In order, as given, plus the ones the options add. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | undefined;
  /** The request's own words, without a leading `curl` and without the app's options: to print it again with another URL. */
  readonly words: readonly string[];
  /** Where the URL is in `words`. */
  readonly urlIndex: number;
}

/** The options the app takes, in one place. Used in the line that refuses any other. */
const ACCEPTED = '-X, -H, -d, --data, --data-raw, --json, -s and -S';

/** Headers the app sets itself, in lower case. */
const OWN_HEADERS = ['payment-signature', 'x-payment'];

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Splits a line as a POSIX shell does, with no expansion. */
export function splitLine(line: string): string[] {
  const words: string[] = [];
  let word = '';
  // True once a word has begun, so that '' is an empty word
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else if (char === '\\') {
        const next = line.charAt(at + 1);
        if (next === '"' || next === '\\' || next === '`' || next === '$') {
          word += next;
          at += 1;
        } else {
          word += char;
        }
      } else {
        word += char;
      }
    } else if (char === ' ' || char === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\') {
      if (at + 1 >= line.length) throw new UsageError('The line ends with a backslash');
      at += 1;
      word += line.charAt(at);
      inWord = true;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote !== undefined) throw new UsageError('A quote is not closed');
  if (inWord) words.push(word);
  return words;
}

const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quoted(word: string): string {
  return BARE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The request's words joined again, shell-quoted, with the URL replaced. */
export function requestLine(request: HttpRequest, url: string): string {
  return request.words.map((word, at) => quoted(at === request.urlIndex ? url : word)).join(' ');
}

const unsupported = (option: string): UsageError =>
  new UsageError(`${option} is not supported. This app takes ${ACCEPTED}`);

function checkUrl(text: string): void {
  const url = URL.parse(text);
  const local = url !== null && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url === null || (url.protocol !== 'https:' && !local)) {
    throw new UsageError('The URL must start with https://');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UsageError('The URL must not hold a user name or a password');
  }
}

function fileRefused(option: string): UsageError {
  return new UsageError(`${option} @file reads a local file. This app never sends local files. Put the body in the line`);
}

/** Reads curl's options and the one URL. Throws a `UsageError`. */
export function parseRequest(given: readonly string[]): HttpRequest {
  const words = given[0] === 'curl' ? given.slice(1) : given;
  let method: string | undefined;
  const headers: [string, string][] = [];
  const data: string[] = [];
  const json: string[] = [];
  const urls: number[] = [];

  let at = 0;
  /** The value of an option: the rest of its word, or the next word. */
  const value = (name: string, rest: string): string => {
    if (rest !== '') return rest;
    const next = words[at + 1];
    if (next === undefined) throw new UsageError(`${name} needs a value`);
    at += 1;
    return next;
  };
  const apply = (name: string, kind: 'X' | 'H' | 'd' | 'raw' | 'json', text: string): void => {
    if (kind === 'X') {
      if (!/^[A-Za-z]+$/.test(text)) throw new UsageError(`${name} needs a method of letters, such as POST`);
      method = text.toUpperCase();
    } else if (kind === 'H') {
      if (text.startsWith('@')) throw fileRefused(name);
      const colon = text.indexOf(':');
      const headerName = colon < 0 ? '' : text.slice(0, colon).trim();
      if (!HEADER_NAME.test(headerName)) {
        throw new UsageError(`${name} needs a header such as 'Name: value'`);
      }
      if (OWN_HEADERS.includes(headerName.toLowerCase())) {
        throw new UsageError(`The app sets ${headerName.toUpperCase()} itself. Remove that header`);
      }
      headers.push([headerName, text.slice(colon + 1).trim()]);
    } else if (kind === 'json') {
      if (text.startsWith('@')) throw fileRefused(name);
      json.push(text);
    } else {
      if (kind === 'd' && text.startsWith('@')) throw fileRefused(name);
      data.push(text);
    }
  };

  const LONG: Readonly<Record<string, 'X' | 'H' | 'd' | 'raw' | 'json' | 'ignore'>> = {
    '--request': 'X',
    '--header': 'H',
    '--data': 'd',
    '--data-raw': 'raw',
    '--json': 'json',
    '--silent': 'ignore',
    '--show-error': 'ignore',
  };

  for (; at < words.length; at += 1) {
    const word = words[at] ?? '';
    if (word.startsWith('--')) {
      const kind = LONG[word];
      if (kind === undefined) throw unsupported(word);
      if (kind !== 'ignore') apply(word, kind, value(word, ''));
    } else if (word.startsWith('-') && word.length > 1) {
      // A cluster of short flags: s and S take nothing; X, H and d take the rest of the word, or the next word
      for (let index = 1; index < word.length; index += 1) {
        const flag = word.charAt(index);
        if (flag === 's' || flag === 'S') continue;
        if (flag !== 'X' && flag !== 'H' && flag !== 'd') throw unsupported(`-${flag}`);
        apply(`-${flag}`, flag, value(`-${flag}`, word.slice(index + 1)));
        break;
      }
    } else {
      urls.push(at);
    }
  }

  if (data.length > 0 && json.length > 0) throw new UsageError('Use -d or --json, not both');
  const urlIndex = urls[0];
  if (urlIndex === undefined) throw new UsageError('No URL. See --help');
  if (urls.length > 1) throw new UsageError('One URL per request');
  const url = words[urlIndex] ?? '';
  checkUrl(url);

  const has = (name: string): boolean => headers.some(([header]) => header.toLowerCase() === name);
  let body: string | undefined;
  if (data.length > 0) {
    body = data.join('&');
    if (!has('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  } else if (json.length > 0) {
    body = json.join('');
    if (!has('content-type')) headers.push(['Content-Type', 'application/json']);
    if (!has('accept')) headers.push(['Accept', 'application/json']);
  }

  const finalMethod = method ?? (body === undefined ? 'GET' : 'POST');
  // fetch refuses these methods, and a body on GET or HEAD, which curl would send
  if (['CONNECT', 'TRACE', 'TRACK'].includes(finalMethod)) throw new UsageError(`-X ${finalMethod} is not supported`);
  if (body !== undefined && (finalMethod === 'GET' || finalMethod === 'HEAD')) {
    throw new UsageError(`-X ${finalMethod} can't carry a body here. Use POST, or put the data in the URL`);
  }

  return {
    method: finalMethod,
    url,
    headers,
    body,
    words,
    urlIndex,
  };
}
