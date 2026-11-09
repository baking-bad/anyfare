import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { Stop } from '../src/util.ts';

describe('loadConfig', () => {
  it('uses the hosted addresses and a cap of 0.02 by default', () => {
    expect(loadConfig({})).toEqual({
      apiUrl: 'https://api.anyfare.agents.bakingbad.dev',
      payUrl: 'https://pay.anyfare.agents.bakingbad.dev',
      maxPayment: 20000n,
      maxPaymentText: '0.02',
    });
  });

  it('takes overrides and removes trailing slashes', () => {
    const config = loadConfig({
      ANYFARE_API_URL: 'http://localhost:3000/',
      ANYFARE_PAY_URL: 'http://localhost:3001//',
      MAX_PAYMENT_USD: '0.5',
    });
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.payUrl).toBe('http://localhost:3001');
    expect(config.maxPayment).toBe(500000n);
    expect(config.maxPaymentText).toBe('0.5');
  });

  it('refuses a bad URL and names the variable', () => {
    expect(() => loadConfig({ ANYFARE_API_URL: 'not a url' })).toThrow(Stop);
    expect(() => loadConfig({ ANYFARE_API_URL: 'not a url' })).toThrow('ANYFARE_API_URL');
    expect(() => loadConfig({ ANYFARE_PAY_URL: 'ftp://host' })).toThrow('ANYFARE_PAY_URL');
  });

  it('refuses a bad cap and a zero cap', () => {
    expect(() => loadConfig({ MAX_PAYMENT_USD: 'cheap' })).toThrow('MAX_PAYMENT_USD');
    expect(() => loadConfig({ MAX_PAYMENT_USD: '1e-2' })).toThrow(Stop);
    expect(() => loadConfig({ MAX_PAYMENT_USD: '0' })).toThrow('MAX_PAYMENT_USD');
    expect(() => loadConfig({ MAX_PAYMENT_USD: '0.0000001' })).toThrow('MAX_PAYMENT_USD');
  });
});
