import { describe, expect, it } from 'vitest';
import { parseRequest, requestLine, splitLine } from '../src/request.ts';
import type { HttpRequest } from '../src/request.ts';
import { UsageError } from '../src/util.ts';

const URL_OK = 'https://api.example.com/v1/price?pair=BTC&x=1';
const parse = (line: string): HttpRequest => parseRequest(splitLine(line));

/** The usage message of a line that is refused. */
function refused(line: string): string {
  try {
    parse(line);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).message;
  }
  throw new Error(`Expected a usage error for: ${line}`);
}

describe('splitLine', () => {
  it('splits on spaces and tabs', () => {
    expect(splitLine('  a  b\tc ')).toEqual(['a', 'b', 'c']);
    expect(splitLine('')).toEqual([]);
    expect(splitLine('   \t ')).toEqual([]);
  });

  it('keeps single quotes literal', () => {
    expect(splitLine(`'a b' '\\n' '"'`)).toEqual(['a b', '\\n', '"']);
  });

  it('takes double quotes with four escapes', () => {
    expect(splitLine('"a b" "say \\"hi\\"" "\\\\ \\$ \\` \\n"')).toEqual(['a b', 'say "hi"', '\\ $ ` \\n']);
  });

  it('takes a backslash outside quotes as the next character', () => {
    expect(splitLine('a\\ b c\\\\d')).toEqual(['a b', 'c\\d']);
  });

  it('joins quotes with the text around them', () => {
    expect(splitLine(`-d'{"a":1}'`)).toEqual(['-d{"a":1}']);
    expect(splitLine(`a'b c'"d e"f`)).toEqual(['ab cd ef']);
  });

  it('keeps an empty quoted word', () => {
    expect(splitLine(`a '' b ""`)).toEqual(['a', '', 'b', '']);
  });

  it('gives no meaning to $, ~, globs or ;', () => {
    expect(splitLine('$HOME ~ *.ts a;b')).toEqual(['$HOME', '~', '*.ts', 'a;b']);
  });

  it('refuses an unclosed quote and a trailing backslash', () => {
    expect(() => splitLine(`a 'b`)).toThrow(new UsageError('A quote is not closed'));
    expect(() => splitLine('a "b')).toThrow(new UsageError('A quote is not closed'));
    expect(() => splitLine('a b\\')).toThrow(new UsageError('The line ends with a backslash'));
  });
});

describe('parseRequest', () => {
  it('reads a plain GET', () => {
    expect(parse(URL_OK)).toEqual({
      method: 'GET',
      url: URL_OK,
      headers: [],
      body: undefined,
      words: [URL_OK],
      urlIndex: 0,
    });
  });

  it('drops a leading curl', () => {
    const request = parse(`curl -X POST ${URL_OK}`);
    expect(request.method).toBe('POST');
    expect(request.words).toEqual(['-X', 'POST', URL_OK]);
    expect(request.urlIndex).toBe(2);
  });

  it('reads the method in its forms, in upper case', () => {
    expect(parse(`-X POST ${URL_OK}`).method).toBe('POST');
    expect(parse(`-XPOST ${URL_OK}`).method).toBe('POST');
    expect(parse(`--request put ${URL_OK}`).method).toBe('PUT');
    expect(refused(`-X PO1 ${URL_OK}`)).toContain('-X');
  });

  it('keeps the headers in order, and trims the value', () => {
    const request = parse(`-H 'A: 1' ${URL_OK} --header 'B:2  ' -HC:\\ 3`);
    expect(request.headers).toEqual([
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ]);
  });

  it('refuses a header without a colon, with a bad name, or that reads a file', () => {
    expect(refused(`-H Accept ${URL_OK}`)).toContain('-H');
    expect(refused(`-H 'bad name: 1' ${URL_OK}`)).toContain('-H');
    expect(refused(`-H @headers.txt ${URL_OK}`)).toContain('never sends local files');
  });

  it('reads a joined -d and several -d', () => {
    expect(parse(`-d'{"a":1}' ${URL_OK}`).body).toBe('{"a":1}');
    const form = parse(`-d a=1 -d b=2 ${URL_OK}`);
    expect(form.body).toBe('a=1&b=2');
    expect(form.method).toBe('POST');
    expect(form.headers).toEqual([['Content-Type', 'application/x-www-form-urlencoded']]);
  });

  it('lets a given Content-Type win over the one -d adds', () => {
    const request = parse(`-H 'content-type: text/plain' -d x ${URL_OK}`);
    expect(request.headers).toEqual([['content-type', 'text/plain']]);
  });

  it('reads --json with both headers and POST', () => {
    const request = parse(`--json '{"a":1}' ${URL_OK}`);
    expect(request.method).toBe('POST');
    expect(request.body).toBe('{"a":1}');
    expect(request.headers).toEqual([
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json'],
    ]);
  });

  it('keeps a given Accept with --json, and still sets the content type', () => {
    const request = parse(`-H 'Accept: text/csv' --json '{}' ${URL_OK}`);
    expect(request.headers).toEqual([
      ['Accept', 'text/csv'],
      ['Content-Type', 'application/json'],
    ]);
  });

  it('joins several --json with nothing between, and keeps -X PUT', () => {
    expect(parse(`--json '{"a":' --json '1}' ${URL_OK}`).body).toBe('{"a":1}');
    expect(parse(`-X PUT --json '{}' ${URL_OK}`).method).toBe('PUT');
  });

  it('refuses a body on GET or HEAD, and the methods fetch refuses', () => {
    expect(refused(`-X GET --json '{}' ${URL_OK}`)).toBe("-X GET can't carry a body here. Use POST, or put the data in the URL");
    expect(refused(`-X head -d a=1 ${URL_OK}`)).toBe("-X HEAD can't carry a body here. Use POST, or put the data in the URL");
    expect(refused(`-X TRACE ${URL_OK}`)).toBe('-X TRACE is not supported');
    expect(refused(`-X connect ${URL_OK}`)).toBe('-X CONNECT is not supported');
  });

  it('refuses -d with --json', () => {
    expect(refused(`-d a=1 --json '{}' ${URL_OK}`)).toBe('Use -d or --json, not both');
    expect(refused(`--data-raw a=1 --json '{}' ${URL_OK}`)).toBe('Use -d or --json, not both');
  });

  it('ignores -s, -S and their long forms', () => {
    for (const flags of ['-sS', '-s -S', '--silent', '--show-error', '-s --silent -S --show-error']) {
      const request = parse(`${flags} ${URL_OK}`);
      expect(request.method).toBe('GET');
      expect(request.url).toBe(URL_OK);
    }
    expect(parse(`-sSX POST ${URL_OK}`).method).toBe('POST');
    expect(parse(`-sSXPOST ${URL_OK}`).method).toBe('POST');
  });

  it('refuses a body that reads a file, but not --data-raw', () => {
    expect(refused(`-d @file ${URL_OK}`)).toBe(
      '-d @file reads a local file. This app never sends local files. Put the body in the line',
    );
    expect(refused(`--data @x ${URL_OK}`)).toContain('--data @file reads a local file');
    expect(refused(`--json @- ${URL_OK}`)).toContain('--json @file reads a local file');
    expect(parse(`--data-raw @x ${URL_OK}`).body).toBe('@x');
  });

  it('refuses the headers the app sets itself, in any case', () => {
    expect(refused(`-H 'PAYMENT-SIGNATURE: x' ${URL_OK}`)).toBe('The app sets PAYMENT-SIGNATURE itself. Remove that header');
    expect(refused(`-H 'x-payment: x' ${URL_OK}`)).toBe('The app sets X-PAYMENT itself. Remove that header');
  });

  it('names any other option', () => {
    expect(refused(`-F a=b ${URL_OK}`)).toBe(
      '-F is not supported. This app takes -X, -H, -d, --data, --data-raw, --json, -s and -S',
    );
    expect(refused(`--data-binary x ${URL_OK}`)).toContain('--data-binary is not supported');
    expect(refused(`-k ${URL_OK}`)).toContain('-k is not supported');
    expect(refused(`-sk ${URL_OK}`)).toContain('-k is not supported');
    expect(refused(`--url ${URL_OK}`)).toContain('--url is not supported');
    expect(refused(`-- ${URL_OK}`)).toContain('-- is not supported');
  });

  it('takes only https, and http for a local host', () => {
    expect(refused('http://example.com')).toBe('The URL must start with https://');
    expect(refused('example.com/x')).toBe('The URL must start with https://');
    expect(refused('ftp://example.com/x')).toBe('The URL must start with https://');
    expect(refused('localhost:8080/x')).toBe('The URL must start with https://');
    expect(refused('https://user:pass@host.example/')).toContain('user name or a password');
    expect(parse('http://localhost:8080/x').url).toBe('http://localhost:8080/x');
    expect(parse('http://127.0.0.1/x').url).toBe('http://127.0.0.1/x');
  });

  it('needs exactly one URL', () => {
    expect(refused('-X POST')).toBe('No URL. See --help');
    expect(refused('')).toBe('No URL. See --help');
    expect(refused('https://a.example/ https://b.example/')).toBe('One URL per request');
  });

  it('names an option whose value is missing', () => {
    expect(refused(`${URL_OK} -X`)).toBe('-X needs a value');
    expect(refused(`${URL_OK} -H`)).toBe('-H needs a value');
    expect(refused(`${URL_OK} --json`)).toBe('--json needs a value');
    expect(refused(`${URL_OK} -sSd`)).toBe('-d needs a value');
  });
});

describe('requestLine', () => {
  const another = 'https://pay.example.net/api/x?a=1&b=2';

  it('replaces the URL and quotes what needs it', () => {
    const request = parse(`curl -X POST -H 'Accept: text/csv' ${URL_OK}`);
    expect(requestLine(request, another)).toBe(`-X POST -H 'Accept: text/csv' '${another}'`);
    expect(requestLine(parse('https://a.example/p'), 'https://b.example/q')).toBe('https://b.example/q');
  });

  it('round-trips a JSON body through splitLine', () => {
    const request = parse(`--json '{"accountId":"anyfare.near","n":[1,2]}' ${URL_OK}`);
    const words = splitLine(requestLine(request, another));
    expect(words).toEqual(request.words.map((word, at) => (at === request.urlIndex ? another : word)));
    expect(parseRequest(words).body).toBe('{"accountId":"anyfare.near","n":[1,2]}');
  });

  it("round-trips a body with a '", () => {
    const request = parse(`-d "it's a=b" ${URL_OK}`);
    const line = requestLine(request, another);
    expect(line).toContain(`'it'\\''s a=b'`);
    expect(splitLine(line)).toEqual(request.words.map((word, at) => (at === request.urlIndex ? another : word)));
  });

  it('keeps an empty word', () => {
    const request = parse(`-d '' ${URL_OK}`);
    expect(request.body).toBe('');
    expect(splitLine(requestLine(request, URL_OK))).toEqual(request.words);
  });
});
