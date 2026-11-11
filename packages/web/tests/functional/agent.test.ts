import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expandWord, shellSteps } from '../support/curl';
import { startStack, type RunningStack } from '../support/localStack';

// An agent that has only the text of /llms.txt, as the built website serves it, and the stack behind the hosts the
// text names. It reads the `curl` commands out of the text, in order, and runs each with the real `curl` program and no
// shell. It substitutes only what the text says to: the variables it sets, and the key it says to save. The one
// outside API the text names is replaced by the stack's fake paid link, and nothing else is changed.

const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const nextBin = fileURLToPath(new URL('../../../../node_modules/next/dist/bin/next', import.meta.url));
// Its own build directory: the other functional tests build into theirs at the same time
const distDir = '.next-agent';

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));

  return port;
};

let running: RunningStack;
let site: ChildProcess | undefined;
let siteUrl: string;
let guide: string;
let work: string;

beforeAll(async () => {
  running = await startStack();
  const build = spawnSync(process.execPath, [nextBin, 'build'], {
    cwd: webRoot,
    env: { ...process.env, NODE_ENV: 'production', NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
  });
  if (build.status !== 0)
    throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);

  const port = await freePort();
  siteUrl = `http://127.0.0.1:${port}`;
  site = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: webRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: '1',
      SITE_URL: siteUrl,
      CONSOLE_URL: 'http://127.0.0.1:1',
      API_URL: running.hosts.apiUrl,
      PAY_URL: running.hosts.payUrl,
      API_INTERNAL_URL: running.hosts.apiUrl,
      PAY_INTERNAL_URL: running.hosts.payUrl,
      LOG_LEVEL: 'silent',
    },
    stdio: 'ignore',
  });
  let up = false;
  for (let attempt = 0; attempt < 150 && !up; attempt += 1) {
    try {
      up = (await fetch(`${siteUrl}/_/health`)).ok;
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (!up)
    throw new Error('The website didn\'t start');
  guide = await (await fetch(`${siteUrl}/llms.txt`)).text();
  work = mkdtempSync(join(tmpdir(), 'anyfare-agent-'));
}, 300_000);

afterAll(async () => {
  site?.kill();
  await running?.stop();
  rmSync(join(webRoot, distDir), { recursive: true, force: true });
  if (work !== undefined)
    rmSync(work, { recursive: true, force: true });
}, 60_000);

interface Result {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  readonly json: any;
}

// The link of the outside paid API the text names, as the stack's fake paid link: the host and path after the pay host
// (or the value of `url=` in a check). Its query stays.
const withFakeLink = (url: string): string => {
  const pay = running.hosts.payUrl;
  if (!url.startsWith(`${pay}/`))
    return url;
  if (url.startsWith(`${pay}/_/check?`))
    return url.replace(/([?&]url=)[^&]+/, `$1${running.paidLink}`);
  if (url.startsWith(`${pay}/_/`))
    return url;
  const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';

  return `${pay}/${running.paidLink}${query}`;
};

// Asynchronous: the stack runs in this process, and a blocked process answers nothing
const curl = async (args: readonly string[], dumpHeaders: boolean): Promise<Result> => {
  const bodyFile = join(work, 'body.out');
  const headerFile = join(work, 'headers.out');
  const child: ChildProcess = spawn('curl', ['-q', '--max-time', '20', '-s', '-o', bodyFile, '-D', headerFile, '-w', '%{http_code}', ...args], {
    cwd: work,
    env: { PATH: process.env['PATH'], HOME: work, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'inherit'] as ['ignore', 'pipe', 'inherit'],
  });
  let status = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    status += chunk.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  const headers = new Headers();
  const blocks = readFileSync(headerFile, 'utf8').trim().split(/\r?\n\r?\n/);
  for (const line of blocks[blocks.length - 1]!.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  let body = readFileSync(bodyFile, 'utf8');
  // `-i` puts the headers in the body: an agent reads them there
  if (dumpHeaders)
    body = body.slice(body.indexOf('\r\n\r\n') + 4);
  let json: unknown;
  try {
    json = JSON.parse(body);
  }
  catch {
    json = undefined;
  }

  return { status: Number(status), headers, body, json };
};

describe('an agent with only /llms.txt', () => {
  it('serves the text, built for the hosts of the stack', () => {
    expect(guide.startsWith('# Anyfare')).toBe(true);
    expect(guide).toContain(running.hosts.payUrl);
    expect(guide).toContain(running.hosts.apiUrl);
    expect(guide).toContain(siteUrl);
  });

  it('signs up, makes a key, checks a link and pays a call, with nothing from outside the text', async () => {
    const steps = shellSteps(guide);
    expect(steps.filter(step => step.kind === 'curl').length).toBeGreaterThanOrEqual(5);

    // What the text says to save: `"key" is shown once: save it as ANYFARE_PAYMENT_KEY`
    const saves = [...guide.matchAll(/"(\w+)" is shown once: save it as ([A-Z_]+)/g)].map(match => ({ field: match[1]!, name: match[2]! }));
    expect(saves.length).toBeGreaterThan(0);

    const variables: Record<string, string> = {};
    let mask = 0o022;
    const results: { readonly url: string; readonly result: Result }[] = [];
    for (const step of steps) {
      if (step.kind === 'umask') {
        mask = step.mask;
      }
      else if (step.kind === 'assign') {
        // The jq read of a file the text saved
        variables[step.name] = JSON.parse(readFileSync(join(work, step.file), 'utf8'))[step.field];
        expect(variables[step.name], `${step.name} from ${step.file}`).toEqual(expect.any(String));
      }
      else {
        const args = step.words.map(word => expandWord(word, variables)).map(arg => /^https?:\/\//.test(arg) ? withFakeLink(arg) : arg);
        const result = await curl(args, args.includes('-i'));
        results.push({ url: args.find(arg => /^https?:\/\//.test(arg))!, result });
        expect(result.status, `${args.join(' ')} answered ${result.body.slice(0, 300)}`).toBeGreaterThanOrEqual(200);
        expect(result.status, `${args.join(' ')} answered ${result.body.slice(0, 300)}`).toBeLessThan(300);
        if (step.redirect !== undefined) {
          const path = join(work, step.redirect);
          writeFileSync(path, result.body);
          chmodSync(path, 0o666 & ~mask);
        }
        for (const save of saves) {
          if (typeof result.json?.[save.field] === 'string')
            variables[save.name] = result.json[save.field];
        }
      }
    }

    const checks = results.filter(item => item.url.includes('/_/check?'));
    expect(checks.length).toBe(2);
    for (const check of checks) {
      expect(check.result.json.payable, check.url).toBe(true);
      expect(check.result.json.link).toBe(`${running.hosts.payUrl}/${running.paidLink}`);
      expect(check.result.json.price).toHaveProperty('amount');
    }
    expect(checks.some(check => check.result.json.method === 'POST')).toBe(true);

    // Sign-up: the master key is in the file, readable by the user alone
    const account = JSON.parse(readFileSync(join(work, 'anyfare-account.json'), 'utf8'));
    expect(account.masterKey).toMatch(/^afm_/);
    expect(statSync(join(work, 'anyfare-account.json')).mode & 0o777).toBe(0o600);
    expect(results.find(item => item.url.endsWith('/v1/accounts'))!.result.status).toBe(201);

    // The key: made with the master key, saved as the text says
    expect(results.find(item => item.url.endsWith('/v1/keys'))!.result.status).toBe(201);
    expect(variables['ANYFARE_PAYMENT_KEY']).toMatch(/^af_/);
    expect(variables['ANYFARE_MASTER_KEY']).toBe(account.masterKey);

    // The call: the receipt header the text promises, and the receipt it says to read
    const paid = results.find(item => item.url.startsWith(`${running.hosts.payUrl}/${running.paidLink}`))!.result;
    expect(paid.status).toBe(200);
    const receipt = /id="(pay_[^"]+)"/.exec(paid.headers.get('anyfare-receipt') ?? '')?.[1];
    expect(receipt).toBeDefined();
    const place = /Read the receipt at (\S+)\/<id>\./.exec(guide)![1]!;
    expect(place).toBe(`${running.hosts.apiUrl}/v1/calls`);
  });

  it('reads the receipt at the place the text names', async () => {
    const place = /Read the receipt at (\S+)\/<id>\./.exec(guide)![1]!;
    expect(existsSync(join(work, 'anyfare-account.json'))).toBe(true);
    // A call is finished a moment after its answer went out, so the text says to read again on 404
    let call: { id: string; service: string } | undefined;
    for (let attempt = 0; attempt < 20 && call === undefined; attempt++) {
      const list = await (await fetch(`${place}?size=5`)).json() as { calls: { id: string; service: string }[] };
      call = list.calls.find(each => each.service === running.stack.paidApiHost);
      if (call === undefined)
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(call).toBeDefined();
    const found = await fetch(`${place}/${call!.id}`);
    expect(found.status).toBe(200);
  });
});
