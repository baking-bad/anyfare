import { describe, expect, it } from 'vitest';

import { logApiFailure } from '../src/api/failures';
import { ApiError, callApi } from '../src/api/http';
import { writeLogLine } from '../src/log';
import { logStartup } from '../src/startup';

// The website's server log: JSON lines on stdout, metadata only

const apiUrl = 'https://api.example.test';

const capture = () => {
  const lines: Record<string, unknown>[] = [];

  return { lines, write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) };
};

const answering = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('a failed Platform API read', () => {
  it('logs one JSON line with the path without its query, the status, the error code, and the duration', async () => {
    const { lines, write } = capture();
    const failing = answering(500, { error: { code: 'internal_error', message: 'Internal server error' } });

    await expect(callApi(apiUrl, { path: '/v1/stats?q=weather&cursor=query-secret', fetch: failing, onFailure: logApiFailure(undefined, { write, env: {} }) }))
      .rejects.toBeInstanceOf(ApiError);

    expect(lines).toEqual([{
      level: 40, time: expect.any(Number), name: 'web', path: '/v1/stats', status: 500, code: 'internal_error', durationMs: expect.any(Number), msg: 'Reading the Platform API failed',
    }]);
    expect(JSON.stringify(lines)).not.toContain('query-secret');
  });

  it('logs an API that doesn\'t answer as api_unavailable with the transport\'s code, and a 404 not at all: it is an answer', async () => {
    const { lines, write } = capture();
    const refused = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' }) });
    };

    await expect(callApi(apiUrl, { path: '/v1/stats', fetch: refused, onFailure: logApiFailure(undefined, { write, env: {} }) })).rejects.toMatchObject({ code: 'api_unavailable' });
    await expect(callApi(apiUrl, { path: '/v1/services/nothing', fetch: answering(404, { error: { code: 'not_found', message: 'Not found' } }), onFailure: logApiFailure(undefined, { write, env: {} }) }))
      .rejects.toMatchObject({ status: 404 });

    expect(lines).toEqual([expect.objectContaining({ level: 40, path: '/v1/stats', status: 503, code: 'api_unavailable', cause: 'ECONNREFUSED' })]);
  });

  it('logs a path that holds a token under the route given instead', async () => {
    const { lines, write } = capture();

    await expect(callApi(apiUrl, { path: '/v1/receipts/rcpt-token', fetch: answering(400, { error: { code: 'bad_request', message: 'Bad' } }), onFailure: logApiFailure('/v1/receipts/:id', { write, env: {} }) }))
      .rejects.toBeInstanceOf(ApiError);

    expect(lines).toEqual([expect.objectContaining({ level: 30, path: '/v1/receipts/:id', status: 400 })]);
    expect(JSON.stringify(lines)).not.toContain('rcpt-token');
  });
});

describe('the website\'s log level and startup line', () => {
  it('writes nothing below LOG_LEVEL, and nothing at silent', () => {
    const { lines, write } = capture();

    writeLogLine('warn', 'dropped', {}, { write, env: { LOG_LEVEL: 'error' } });
    writeLogLine('info', 'dropped', {}, { write, env: { LOG_LEVEL: 'silent' } });
    writeLogLine('error', 'kept', {}, { write, env: { LOG_LEVEL: 'ERROR' } });
    writeLogLine('debug', 'dropped', {}, { write, env: {} });

    expect(lines.map(line => line['msg'])).toEqual(['kept']);
  });

  it('logs one startup line with the commit and the URLs', () => {
    const { lines, write } = capture();

    logStartup({ write, env: { GIT_SHA: 'F7B6FFB', SITE_URL: 'https://site.test', CONSOLE_URL: 'https://console.test', API_URL: apiUrl, PAY_URL: 'https://pay.test', LOG_LEVEL: 'debug' } });

    expect(lines).toEqual([expect.objectContaining({
      level: 30, name: 'web', app: 'web', commit: 'f7b6ffb', logLevel: 'debug',
      urls: { website: 'https://site.test', console: 'https://console.test', api: apiUrl, pay: 'https://pay.test' }, msg: 'Started',
    })]);
  });

  it('logs invalid settings with the variable\'s name, at error', () => {
    const { lines, write } = capture();

    logStartup({ write, env: { API_URL: 'not a url' } });

    expect(lines).toEqual([expect.objectContaining({ level: 50, msg: 'The website\'s settings are invalid', error: { type: 'InvalidSettingError', message: expect.stringContaining('API_URL') } })]);
  });
});
