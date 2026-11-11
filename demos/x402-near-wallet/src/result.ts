// The result block: the API's answer under a left bar, and the proof of a payment. The answer is the
// API's own text, so every line is cleaned of control characters: an escape sequence could change the
// terminal or hide a line. Any body is shown in time and memory linear in its size, and showing it
// never throws: the answer comes after a payment, which must still be reported.

import type { Answer } from './http.ts';
import type { Style } from './style.ts';

/** Lines shown, and characters a line, unless `--full`. */
export const MAX_LINES = 40;
export const MAX_WIDTH = 200;
/** JSON nested deeper than this is shown as its own text: its indent alone would be too long. */
export const MAX_DEPTH = 64;
const PROOF_LABEL_WIDTH = 14;

// C0 and C1 controls (the tab is kept, to be replaced), and the marks that reorder or split a line
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** One line of the API's text, safe to print: a tab is two spaces, any other control character is taken out. */
export function cleanLine(text: string): string {
  return text.replaceAll('\t', '  ').replace(CONTROL, '');
}

/** At most `MAX_WIDTH` characters, then `…`. Counted by code points, so no character is cut in half. */
function cut(line: string): string {
  // Each code point is one or two UTF-16 units: this many units hold more than MAX_WIDTH code points
  const window = 2 * MAX_WIDTH + 2;
  const head = Array.from(line.length > window ? line.slice(0, window) : line);
  return head.length > MAX_WIDTH ? `${head.slice(0, MAX_WIDTH).join('')}…` : line;
}

/** The first lines of a body, at most the limit, and how many lines it has in all. */
export interface BodyLines {
  readonly lines: readonly string[];
  readonly total: number;
}

/** The text without the line breaks at its end. */
function withoutLastBreaks(text: string): string {
  let end = text.length;
  while (end > 0 && (text.charAt(end - 1) === '\n' || text.charAt(end - 1) === '\r')) end -= 1;
  return text.slice(0, end);
}

/** The first `limit` lines of a text, as it is, and how many lines it has. */
export function textLines(text: string, limit: number): BodyLines {
  const lines: string[] = [];
  let total = 0;
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (lines.length < limit) lines.push(text.slice(start, end < 0 ? text.length : end));
    total += 1;
    if (end < 0) break;
    start = end + 1;
  }
  return { lines, total };
}

const space = (char: string): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r';

/**
 * The first `limit` lines of valid JSON indented by 2 spaces, as `JSON.stringify(value, null, 2)`
 * writes it, and how many lines it has; `undefined` for text that is not JSON, or that is nested
 * deeper than `MAX_DEPTH`. Its own text is kept: a number keeps every digit, and a string its escapes.
 * One pass, and lines past the limit are only counted.
 */
export function prettyLines(text: string, limit: number): BodyLines | undefined {
  const lines: string[] = [];
  let total = 0;
  let line = '';
  let depth = 0;
  const building = (): boolean => lines.length < limit;
  const add = (part: string): void => {
    if (building()) line += part;
  };
  const end = (next: string): void => {
    if (building()) lines.push(line);
    total += 1;
    line = building() ? next : '';
  };
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === '"') {
      let close = at + 1;
      while (close < text.length && text.charAt(close) !== '"') close += text.charAt(close) === '\\' ? 2 : 1;
      add(text.slice(at, close + 1));
      at = close;
    } else if (char === '{' || char === '[') {
      const pair = char === '{' ? '}' : ']';
      let next = at + 1;
      while (next < text.length && space(text.charAt(next))) next += 1;
      // An empty object or list stays on its line
      if (text.charAt(next) === pair) {
        add(`${char}${pair}`);
        at = next;
      } else {
        depth += 1;
        if (depth > MAX_DEPTH) return undefined;
        add(char);
        end('  '.repeat(depth));
      }
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth < 0) return undefined;
      end(`${'  '.repeat(depth)}${char}`);
    } else if (char === ',') {
      add(',');
      end('  '.repeat(depth));
    } else if (char === ':') {
      add(': ');
    } else if (!space(char)) {
      add(char);
    }
  }
  if (depth !== 0) return undefined;
  if (building()) lines.push(line);
  total += 1;
  // Not nested past MAX_DEPTH, so the parser's work is bounded too
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  return { lines, total };
}

/** Valid JSON indented by 2 spaces, whole, or `undefined`. */
export function prettyJson(text: string): string | undefined {
  return prettyLines(text, Number.POSITIVE_INFINITY)?.lines.join('\n');
}

/** The media type of a `Content-Type`, without its parameters: one short line, or `undefined` when there is none. */
export function mediaType(contentType: string | null): string | undefined {
  const type = cleanLine((contentType ?? '').slice(0, 1_000).split(';')[0] ?? '').trim();
  if (type === '') return undefined;
  return type.length > 80 ? `${type.slice(0, 80)}…` : type;
}

/** Whether a media type is text this app shows. */
function isText(type: string): boolean {
  const lower = type.toLowerCase();
  return (
    lower.startsWith('text/') ||
    lower === 'application/json' ||
    lower === 'application/xml' ||
    lower.endsWith('+json') ||
    lower.endsWith('+xml') ||
    lower === 'application/x-www-form-urlencoded' ||
    lower === 'application/javascript'
  );
}

/** The body's text, or `undefined` for a body that is not text. */
function bodyText(bytes: Uint8Array, type: string | undefined): string | undefined {
  if (type === undefined) {
    // No type: shown when it is UTF-8 text
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  return isText(type) ? new TextDecoder().decode(bytes) : undefined;
}

/** The body's lines, pretty JSON or the text as it is; its own text when pretty-printing fails in any way. */
function bodyLines(text: string, limit: number): BodyLines {
  const trimmed = withoutLastBreaks(text);
  try {
    const pretty = prettyLines(trimmed, limit);
    if (pretty !== undefined) return pretty;
  } catch {
    // Shown as its own text below
  }
  return textLines(trimmed, limit);
}

export interface ResultOptions {
  /** Show every line, whole. */
  readonly full: boolean;
  /** Rows of the proof of a payment: a label and its value. */
  readonly proof?: readonly (readonly [string, string])[];
}

type Shown = Pick<Answer, 'status' | 'headers' | 'bytes' | 'ms'>;

/**
 * The answer's part of the block: a header with the status, the media type and the time; the body
 * under a bar, at most 40 lines of at most 200 characters unless `full`. Never throws.
 */
export function answerLines(style: Style, answer: Shown, options: Pick<ResultOptions, 'full'>): string[] {
  const { title, bar } = style.styles;
  const row = (text: string): string => (text === '' ? ` ${bar('│')}` : ` ${bar('│')} ${text}`);
  let type: string | undefined;
  let lines: string[];
  try {
    type = mediaType(answer.headers.get('content-type'));
    const seconds = (answer.ms / 1000).toFixed(1);
    lines = [title(` Result · HTTP ${answer.status} · ${type ?? 'no content type'} · ${seconds} s`)];
  } catch {
    lines = [title(` Result · HTTP ${answer.status}`)];
  }
  try {
    const text = answer.bytes.length === 0 ? undefined : bodyText(answer.bytes, type);
    if (answer.bytes.length === 0) {
      lines.push(row('(empty)'));
    } else if (text === undefined) {
      lines.push(row(`${answer.bytes.length} bytes of ${type ?? 'unknown type'}, not shown`));
    } else {
      const body = bodyLines(text, options.full ? Number.POSITIVE_INFINITY : MAX_LINES);
      for (const line of body.lines) {
        const clean = cleanLine(line);
        lines.push(row(options.full ? clean : cut(clean)));
      }
      const more = body.total - body.lines.length;
      if (more > 0) lines.push(row(`… ${more} more line${more === 1 ? '' : 's'}`));
    }
  } catch {
    lines.push(row('(the answer could not be shown)'));
  }
  return lines;
}

/** The proof's part of the block: its rows, labels padded to 14. None when there are no rows. */
export function proofLines(style: Style, proof: readonly (readonly [string, string])[]): string[] {
  if (proof.length === 0) return [];
  const { title, bar, label } = style.styles;
  return [title(' Proof'), ...proof.map(([name, value]) => ` ${bar('│')} ${label(name.padEnd(PROOF_LABEL_WIDTH))}${value}`)];
}

/** The whole result block: the answer, then the proof's rows when given. Never throws. */
export function resultBlock(style: Style, answer: Shown, options: ResultOptions): string[] {
  return [...answerLines(style, answer, options), ...proofLines(style, options.proof ?? [])];
}
