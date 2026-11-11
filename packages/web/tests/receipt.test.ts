import { describe, expect, it } from 'vitest';

import { readSettings } from '../src/config';
import { receiptMarkdown } from '../src/markdown/receipt';
import { markdownPageFor } from '../src/markdown/pages';
import { pageForMarkdownUrl } from '../src/markdown/negotiate';
import { callLine, explorerName, isReceiptId, paidAmount, safeExplorerUrl, seconds, shortHash, statusWords, stepTime, stepWords, tokenAmount, utcMoment } from '../src/receipt/content';
import { loadReceipt } from '../src/receipt/data';
import { sampleReceipt } from './support/fakeApi';
import type { Receipt } from '../src/api/types';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const settings = readSettings({ SITE_URL: 'https://site.example.com', API_URL: 'https://api.example.com', PAY_URL: 'https://pay.example.com', CONSOLE_URL: 'https://console.example.com' });
const receipt = (id: string): Receipt => sampleReceipt(id, now)!;

describe('the id of a receipt', () => {
  it('is letters, digits, _ and -, up to 64', () => {
    expect(isReceiptId('pay_01-AZaz')).toBe(true);
    expect(isReceiptId('a'.repeat(64))).toBe(true);
    for (const bad of ['', 'a'.repeat(65), 'a b', 'a/b', 'a.b', '../x', 'a?b', 'é'])
      expect(isReceiptId(bad), bad).toBe(false);
  });

  it('is never asked of the API when it is not one', async () => {
    let asked = 0;
    const read = (() => { asked += 1; return Promise.resolve({ ok: false, error: { status: 500, code: 'x', message: 'x' } }); }) as never;

    expect(await loadReceipt(read, 'bad id')).toEqual({ ok: false, error: { status: 404, code: 'not_found', message: 'No call with this id.' } });
    expect(asked).toBe(0);
  });
});

describe('the explorers', () => {
  it.each([
    ['https://nearblocks.io/txns/abc', 'NearBlocks'],
    ['https://basescan.org/tx/0xabc', 'Basescan'],
    ['https://solscan.io/tx/abc', 'Solscan'],
    ['https://explorer.solana.com/tx/abc', 'Solana Explorer'],
    ['https://www.nearblocks.io/txns/abc', 'NearBlocks'],
    ['https://scan.example.com/tx/abc', 'scan.example.com'],
  ])('names %s as %s', (url, name) => {
    expect(explorerName(url)).toBe(name);
  });

  it('links only to http and https', () => {
    expect(safeExplorerUrl('https://basescan.org/tx/0x1')).toBe('https://basescan.org/tx/0x1');
    expect(safeExplorerUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeExplorerUrl('not a url')).toBeUndefined();
    expect(safeExplorerUrl(null)).toBeUndefined();
  });
});

describe('how a receipt reads', () => {
  it('shortens a hash and keeps a short one whole', () => {
    expect(shortHash('7HkQabcdefghijklmnope2Lm')).toBe('7HkQ…e2Lm');
    expect(shortHash(`0x5b2e${'0'.repeat(30)}91af`)).toBe('0x5b2e…91af');
    expect(shortHash('abc123')).toBe('abc123');
  });

  it('writes amounts, times and seconds as the page shows them', () => {
    expect(tokenAmount('0.01')).toBe('0.010');
    expect(tokenAmount('0.0123')).toBe('0.0123');
    expect(tokenAmount('1')).toBe('1.000');
    expect(seconds(916)).toBe('0.92 s');
    expect(utcMoment('2026-11-11T10:05:12.104Z')).toBe('11 Nov 2026, 10:05:12 UTC');
    expect(stepTime('2026-11-11T10:05:12.104Z')).toBe('10:05:12.104');
  });

  it('words the status of a paid call, a free call, and a call the API never answered', () => {
    expect(statusWords(receipt('pay_sample0000'))).toBe('Paid · API answered 200');
    expect(statusWords(receipt('pay_freenoapi'))).toBe('Not charged');
    expect(statusWords({ ...receipt('pay_freenoapi'), apiStatus: 502 })).toBe('Not charged · API answered 502');
    expect(paidAmount(receipt('pay_freenoapi'))).toBe('$0');
    expect(paidAmount(receipt('pay_sample0000'))).toBe('$0.001');
  });

  it('gives the path alone when the method is unknown', () => {
    expect(callLine(receipt('pay_sample0000'))).toBe('GET /v1/sample/quotes/latest');
    expect(callLine({ ...receipt('pay_sample0000'), method: null })).toBe('/v1/sample/quotes/latest');
  });
});

describe('the words of each step', () => {
  const chain = receipt('pay_sample0000');
  const credits = receipt('pay_creditspaid');
  const free = receipt('pay_freenoapi');

  it('words a call paid on a chain', () => {
    expect(stepWords('received', chain)).toEqual({ title: 'The buyer asked, with a payment' });
    expect(stepWords('authorized', chain)).toEqual({ title: 'We checked the buyer\'s payment', note: 'x402 on NEAR. Not settled yet' });
    expect(stepWords('api_signed', chain)).toEqual({ title: 'We signed 0.001 USDC on Base for the API', note: 'From our Base hot wallet' });
    expect(stepWords('api_answered', chain)).toEqual({ title: 'The API answered 200 in 120 ms', note: 'The answer went to the buyer as it came' });
    expect(stepWords('settled', chain)).toEqual({ title: 'The buyer\'s payment settled on NEAR', note: 'Only now: a failed call is never settled' });
  });

  it('words a call paid from Credits', () => {
    expect(stepWords('authorized', credits)).toEqual({ title: 'We held $0.010 on the buyer\'s balance' });
    expect(stepWords('settled', credits)).toEqual({ title: 'The hold was taken from the balance' });
  });

  it('words an MPP payment, a release, and a missing answer', () => {
    expect(stepWords('authorized', receipt('pay_notxlink')).note).toBe('MPP on Tempo. Not settled yet');
    expect(stepWords('released', free)).toEqual({ title: 'The buyer was not charged' });
    expect(stepWords('api_answered', free)).toEqual({ title: 'The API answered' });
    expect(stepWords('api_answered', { ...free, apiStatus: 502 }).note).toBeUndefined();
  });

  it('shows the code of a step it does not know', () => {
    expect(stepWords('mystery_step', chain)).toEqual({ title: 'mystery_step' });
  });

  it('keeps the steps the API gave, in its order, and none of its own', () => {
    expect(receipt('pay_sample0000').steps.map(step => step.step)).toEqual(['received', 'authorized', 'api_signed', 'api_answered', 'settled']);
    expect(free.steps.map(step => step.step)).toEqual(['received', 'authorized', 'released']);
  });
});

describe('the Markdown twin', () => {
  it('has the same facts as the page for a call paid on a chain, with whole transactions', () => {
    const markdown = receiptMarkdown(settings, receipt('pay_sample0000'));

    expect(markdown).toMatch(/^# Receipt pay_sample0000\n/);
    expect(markdown).toContain('- Paid: $0.001. The API answered 200 in 120 ms.');
    expect(markdown).toContain('- Buyer: sample.near paid 0.001 USDC on NEAR, tx NearSample0000Tx9 on [NearBlocks](https://nearblocks.io/txns/NearSample0000Tx9)');
    expect(markdown).toContain('- API: we paid 0.001 USDC on Base to api.example.com, tx ');
    expect(markdown).toContain('- Fee: $0.00');
    expect(markdown).toMatch(/- 11:59:57\.120 UTC: We checked the buyer's payment\. x402 on NEAR\. Not settled yet/);
    expect(markdown).toContain('UTC: We signed 0.001 USDC on Base for the API');
    expect(markdown).toContain('`GET https://api.example.com/v1/calls/pay_sample0000`');
    expect(markdown).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it('says a Credits buyer paid from a balance, with no payer and no transaction', () => {
    const markdown = receiptMarkdown(settings, receipt('pay_creditspaid'));

    expect(markdown).toContain('- Buyer: paid 0.010 in Credits. Paid from a balance. No transaction per call.');
    expect(markdown).not.toMatch(/account/i);
    expect(markdown.split('\n').find(line => line.startsWith('- Buyer:'))).not.toMatch(/tx|0x/);
  });

  it('says a free call did not charge, and that the API was not paid when it was not', () => {
    const markdown = receiptMarkdown(settings, receipt('pay_freenoapi'));

    expect(markdown).toContain('- Not charged: $0.');
    expect(markdown).toContain('- API: We did not pay the API for this call.');
    expect(markdown).toContain('The buyer was not charged');
  });

  it('gives a transaction with no explorer URL as the hash alone', () => {
    const markdown = receiptMarkdown(settings, receipt('pay_notxlink'));

    expect(markdown).toMatch(/- Buyer: sample\.near paid 0\.002 USDC\.e on Tempo, tx 0x[0-9a-f]+\n/);
  });

  it('is listed for a receipt path, and for no other id', () => {
    expect(markdownPageFor('/calls/pay_sample0000')).toBeDefined();
    expect(markdownPageFor('/calls/a b')).toBeUndefined();
    expect(pageForMarkdownUrl('/calls/pay_sample0000.md')).toBe('/calls/pay_sample0000');
    expect(pageForMarkdownUrl('/calls/a$b.md')).toBeUndefined();
  });
});
