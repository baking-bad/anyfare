// The result block of a call paid with Credits, with colors off, and the style that makes it. The
// block for the other ways to pay is checked in their own tests. Every value here is made up.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { createStyle } from '../src/style.ts';
import { forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare } from './fakeAnyfare.ts';
import { captureIo, expectResultShape, tempAppDir } from './helpers.ts';
import type { IoOptions } from './helpers.ts';
import { Writable } from 'node:stream';

let fake: FakeAnyfare;
let app: { dir: string; remove: () => void };

beforeAll(async () => {
  fake = await startFakeAnyfare();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  for (const target of Object.values(toolTargets())) fake.addTarget(target);
  app = tempAppDir();
});
afterEach(() => {
  app.remove();
});

async function pay(tool: 'cmc' | '3route' | 'evidence', options: IoOptions = {}, extra: readonly string[] = ['--yes']) {
  const account = fake.addAccount('1');
  const key = fake.addKey(account, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
  const { fetch } = forwardingFetch(toolRoutes());
  const io = captureIo(
    fetch,
    { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ANYFARE_PAYMENT_KEY: key.key },
    { appDir: app.dir, ...options },
  );
  const code = await runCli(['call', '--tool', tool, '--pay', 'credits', ...extra], io.io);
  return { code, out: io.out(), err: io.err() };
}

describe('the result block, with Credits and no colors', () => {
  it('stands apart for CoinMarketCap: header, answer under a bar, closing line, the receipt, the story', async () => {
    const result = await pay('cmc');
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expectResultShape(result.out, {
      name: 'CoinMarketCap',
      answer: [
        'Bitcoin Real (BTC)',
        'Price       12,345.68 USD',
        '24h         +2.50%',
        'Market cap  987,654,322',
        'Updated     2026-11-09T10:00:05.000Z',
      ],
      proof: [/^Receipt pay_madeup\d+: \$0\.011 of Credits$/],
      story: '✔ You paid with Credits. Anyfare paid CoinMarketCap in USDC on Base from its own wallet.',
    });
  });

  it('stands apart for 3Route, with its two-line rate', async () => {
    const result = await pay('3route');
    expectResultShape(result.out, {
      name: '3Route',
      answer: [
        '1 USDC → 0.00025 WETH',
        'Rate        1 USDC = 0.00025 WETH',
        '            1 WETH = 4000 USDC',
        'Gas         150000',
        'Block 12345678 on Base',
      ],
      proof: [/^Receipt pay_madeup\d+: \$0\.0012 of Credits$/],
      story: '✔ You paid with Credits. Anyfare paid 3Route in USDC on Base from its own wallet.',
    });
  });

  it('stands apart for the evidence API, named in lower case inside the calling line', async () => {
    const result = await pay('evidence');
    expectResultShape(result.out, {
      name: 'The evidence API',
      answer: [
        'Account     anyfare.near',
        'Balance     1.23456 NEAR',
        'Storage     4242 bytes',
        'Contract    no',
        'Block       123456789 (FakeBlockHashForTheTest1111111111111111111)',
        'Finality    final',
        'Observed    2026-11-09T10:15:00.000Z',
      ],
      proof: [/^Receipt pay_madeup\d+: \$0\.002 of Credits$/],
      story: '✔ You paid with Credits. Anyfare paid the evidence API in USDC on NEAR from its own wallet.',
    });
    expect(result.out).toContain('▸ Calling the evidence API through Anyfare');
  });

  it('leaves out the proof header when no receipt came, and warns on stderr', async () => {
    fake.nextPaid = { status: 200, noReceipt: true };
    const result = await pay('cmc');
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Proof');
    expect(result.err).toContain('No receipt came with the answer.');
    // The story line is still last, after one blank line
    const lines = result.out.trimEnd().split('\n');
    expect(lines.at(-1)).toMatch(/^✔ You paid with Credits\./);
    expect(lines.at(-2)).toBe('');
    expect(lines.at(-3)).toBe(`  └${'─'.repeat(45)}`);
  });

  it('puts one blank line before the question and keeps the plan above it', async () => {
    const result = await pay('cmc', { isTerminal: true, input: 'y\n' }, []);
    expect(result.out).toMatch(/\$0\.011 of Credits\n\nPay \$0\.011 of Credits\? \[y\/N\] /);
  });

  it('puts the same blank line before the question with --explain', async () => {
    const result = await pay('cmc', { isTerminal: true, input: 'y\n' }, ['--explain']);
    expect(result.out).toMatch(/This quote is within it\.\n\nPay \$0\.011 of Credits\? \[y\/N\] /);
  });
});

describe('the result style', () => {
  const stream = new Writable({ write: (_chunk, _encoding, done) => done() });
  const style = createStyle(stream);

  it('keeps the same characters without colors, and the same widths', () => {
    const lines = style.result('Some Tool', ['Plain line', 'Label       value here', '            continued'], ['Receipt r1: $0.01', 'https://example.test/tx/1']);
    expect(lines).toEqual([
      '',
      '━━ Result: Some Tool ━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '  │ Plain line',
      '  │ Label       value here',
      '  │             continued',
      `  └${'─'.repeat(45)}`,
      '  Proof',
      '    Receipt r1: $0.01',
      '    https://example.test/tx/1',
      '',
    ]);
    expect(lines[1]).toHaveLength(48);
  });

  it('has no proof header without proof lines', () => {
    expect(style.result('T', ['x'], []).join('\n')).not.toContain('Proof');
  });

  it('is not fooled by a one-space gap in a line of text', () => {
    // Only a label padded to its width, with two spaces or more, is split from its value
    expect(style.result('T', ['Block 12345 on base'], [])[2]).toBe('  │ Block 12345 on base');
  });
});
