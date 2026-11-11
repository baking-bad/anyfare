import { describe, expect, it } from 'vitest';
import { DEFAULT_PAY_URL, loadConfig } from '../src/config.ts';
import { Stop } from '../src/util.ts';

function stopOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Stop);
    return (error as Stop).message;
  }
  throw new Error('Expected a Stop');
}

describe('loadConfig', () => {
  it('has defaults', () => {
    expect(loadConfig({})).toEqual({
      payUrl: DEFAULT_PAY_URL,
      maxPayment: 20_000n,
      maxPaymentText: '$0.02',
      capFrom: 'MAX_PAYMENT_USD',
    });
    expect(DEFAULT_PAY_URL).toBe('https://pay.anyfare.agents.bakingbad.dev');
  });

  it('reads MAX_PAYMENT_USD, as the shortest dollar text', () => {
    expect(loadConfig({ MAX_PAYMENT_USD: '0.50' })).toMatchObject({ maxPayment: 500_000n, maxPaymentText: '$0.5' });
    expect(loadConfig({ MAX_PAYMENT_USD: '1' })).toMatchObject({ maxPayment: 1_000_000n, maxPaymentText: '$1' });
    expect(loadConfig({ MAX_PAYMENT_USD: ' 0.000001 ' })).toMatchObject({ maxPayment: 1n, maxPaymentText: '$0.000001' });
    expect(loadConfig({ MAX_PAYMENT_USD: '' }).maxPaymentText).toBe('$0.02');
  });

  it('lets --max win over MAX_PAYMENT_USD', () => {
    expect(loadConfig({ MAX_PAYMENT_USD: '0.5' }, { maxUsd: '0.05' })).toMatchObject({
      maxPayment: 50_000n,
      maxPaymentText: '$0.05',
      capFrom: '--max',
    });
    // A bad variable is not looked at when --max is given
    expect(loadConfig({ MAX_PAYMENT_USD: 'abc' }, { maxUsd: '1' }).capFrom).toBe('--max');
  });

  it('refuses a bad MAX_PAYMENT_USD and names the variable', () => {
    for (const bad of ['0', '0.0', 'abc', '-1', '1e3', '.5', '0.0000001', '1,5', '$1']) {
      expect(stopOf(() => loadConfig({ MAX_PAYMENT_USD: bad })), bad).toContain('MAX_PAYMENT_USD');
    }
  });

  it('refuses a bad --max and names the flag', () => {
    expect(stopOf(() => loadConfig({}, { maxUsd: '0' }))).toContain('--max');
    expect(stopOf(() => loadConfig({}, { maxUsd: '0.0000001' }))).toContain('--max');
  });

  it('takes ANYFARE_PAY_URL without trailing slashes', () => {
    expect(loadConfig({ ANYFARE_PAY_URL: 'https://pay.example///' }).payUrl).toBe('https://pay.example');
    expect(loadConfig({ ANYFARE_PAY_URL: 'https://pay.example:8443' }).payUrl).toBe('https://pay.example:8443');
    expect(loadConfig({ ANYFARE_PAY_URL: 'http://127.0.0.1:3000/' }).payUrl).toBe('http://127.0.0.1:3000');
    expect(loadConfig({ ANYFARE_PAY_URL: 'http://localhost:3000' }).payUrl).toBe('http://localhost:3000');
  });

  it('refuses an ANYFARE_PAY_URL that is not https or local http', () => {
    for (const bad of ['http://pay.example', 'ftp://pay.example', 'pay.example', 'https://user:pw@pay.example']) {
      expect(stopOf(() => loadConfig({ ANYFARE_PAY_URL: bad })), bad).toContain('ANYFARE_PAY_URL');
    }
  });

  it('refuses a path, a query or a fragment in ANYFARE_PAY_URL', () => {
    for (const bad of ['https://pay.example/v1', 'https://pay.example/?a=b', 'https://pay.example?a=b', 'https://pay.example#x', 'https://pay.example/#']) {
      expect(stopOf(() => loadConfig({ ANYFARE_PAY_URL: bad })), bad).toContain('ANYFARE_PAY_URL');
    }
  });
});
