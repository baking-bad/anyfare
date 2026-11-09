import { describe, expect, it } from 'vitest';
import { payWayOf, readOffers } from '../src/offers.ts';
import type { Offer } from '../src/offers.ts';
import { Stop } from '../src/util.ts';
import { answerOf, fixture } from './helpers.ts';

async function offersOf(name: string) {
  const response = answerOf(name);
  return readOffers({ headers: response.headers, body: await response.json() });
}

describe('readOffers', () => {
  it("reads CoinMarketCap's 402: seven exact options", async () => {
    const { x402Version, offers } = await offersOf('cmc-402.json');
    expect(x402Version).toBe(2);
    expect(offers).toHaveLength(7);
    expect(offers.every((offer) => offer.protocol === 'x402' && offer.scheme === 'exact')).toBe(true);
    const base = offers.filter((offer) => offer.network === 'eip155:8453');
    expect(base).toHaveLength(1);
    expect(base[0]).toMatchObject({
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: 10000n,
      transferMethod: 'eip3009',
    });
    expect(offers.filter((offer) => offer.network === 'eip155:56')).toHaveLength(6);
  });

  it("reads 3Route's 402: x402 options and an MPP challenge", async () => {
    const { offers } = await offersOf('3route-402.json');
    expect(offers.map((offer) => [offer.protocol, offer.scheme, offer.network])).toEqual([
      ['x402', 'exact', 'eip155:8453'],
      ['x402', 'batch-settlement', 'eip155:8453'],
      ['x402', 'exact', 'eip155:42793'],
      ['x402', 'exact', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      ['mpp', 'charge', 'eip155:4217'],
    ]);
    const mpp = offers[4];
    expect(mpp).toMatchObject({
      method: 'tempo',
      asset: '0x20C000000000000000000000b9537d11c60E8b50',
      amount: 1000n,
    });
  });

  it("reads the evidence API's 402: one NEAR option", async () => {
    const { offers } = await offersOf('evidence-402.json');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      scheme: 'exact',
      network: 'near:mainnet',
      amount: 1000n,
      recipient: 'count.mike.near',
    });
  });

  it("reads Anyfare's combined 402: x402, MPP and Credits", async () => {
    const { offers } = await offersOf('anyfare-402-cmc.json');
    expect(offers.map((offer) => offer.protocol)).toEqual(['x402', 'x402', 'x402', 'mpp', 'credits']);
    expect(offers[4]).toMatchObject({ scheme: 'credits', amount: 11000n });
  });

  it('keeps the decoded payment-required header for a payer to sign from', async () => {
    const { offers, paymentRequired } = await offersOf('anyfare-402-cmc.json');
    expect(paymentRequired?.['x402Version']).toBe(2);
    expect(paymentRequired?.['resource']).toEqual({
      url: 'https://pay.example.test/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest',
      description: 'Payment required',
    });
    // Each x402 offer holds its own object of that header
    const accepts = paymentRequired?.['accepts'] as unknown[];
    expect(offers.filter((offer) => offer.protocol === 'x402').map((offer) => offer.raw)).toEqual(accepts);
    expect(readOffers({ headers: new Headers(), body: { credits: { price: '0.01' } } }).paymentRequired).toBeUndefined();
  });

  it('falls back to the JSON body when the header is missing', async () => {
    const { body } = fixture('cmc-402.json');
    const { x402Version, offers } = readOffers({ headers: new Headers(), body });
    expect(x402Version).toBe(2);
    expect(offers).toHaveLength(7);
  });

  it('reads no options from a body that has none', () => {
    expect(readOffers({ headers: new Headers(), body: {} }).offers).toEqual([]);
    expect(readOffers({ headers: new Headers(), body: 'nope' }).offers).toEqual([]);
  });

  it('ignores a challenge that is not a Payment one', () => {
    const headers = new Headers({ 'www-authenticate': 'Bearer realm="x"' });
    expect(readOffers({ headers, body: {} }).offers).toEqual([]);
  });

  it('stops on a malformed payment-required header', () => {
    const headers = new Headers({ 'payment-required': '!!not base64 json!!' });
    expect(() => readOffers({ headers, body: {} })).toThrow(Stop);
    expect(() => readOffers({ headers, body: {} })).toThrow('payment-required header');
  });

  it('stops on a malformed MPP challenge', () => {
    const headers = new Headers({
      'www-authenticate': 'Payment id="a", realm="b", method="tempo", intent="charge", request="!!!"',
    });
    expect(() => readOffers({ headers, body: {} })).toThrow(Stop);
  });

  it('stops on an amount that is not a whole number', () => {
    const body = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'near:mainnet', asset: 'a', amount: '1.5' }] };
    expect(() => readOffers({ headers: new Headers(), body })).toThrow('not a whole number');
  });
});

describe('the Credits currency', () => {
  it('keeps the currency of the 402 as given, and none when it gave none', () => {
    const parts = (credits: Record<string, unknown>) => ({ headers: new Headers(), body: { credits } });
    expect(readOffers(parts({ price: '0.01', currency: 'USD' })).offers[0]?.asset).toBe('USD');
    expect(readOffers(parts({ price: '0.01', currency: 'EUR' })).offers[0]?.asset).toBe('EUR');
    expect(readOffers(parts({ price: '0.01' })).offers[0]?.asset).toBeUndefined();
  });
});

describe('payWayOf', () => {
  const offer = (fields: Partial<Offer> & Pick<Offer, 'protocol' | 'scheme'>): Offer => ({
    amount: 1n,
    raw: {},
    ...fields,
  });

  it('pays Credits with credits', () => {
    expect(payWayOf(offer({ protocol: 'credits', scheme: 'credits' }))).toBe('credits');
  });

  it('pays x402 exact USDC on NEAR with near, and no other asset on NEAR', () => {
    const usdc = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'near:mainnet', asset: usdc }))).toBe('near');
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'near:mainnet' }))).toBeUndefined();
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'near:mainnet', asset: 'usdt.tether-token.near' }))).toBeUndefined();
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'near:mainnet', asset: usdc.toUpperCase() }))).toBeUndefined();
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'upto', network: 'near:mainnet', asset: usdc }))).toBeUndefined();
  });

  it('pays x402 exact USDC on Base with base, in any letter case', () => {
    const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'eip155:8453', asset: usdc }))).toBe('base');
    expect(
      payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'eip155:8453', asset: usdc.toLowerCase() })),
    ).toBe('base');
  });

  it('pays an MPP tempo charge of USDC.e on chain 4217 with tempo, in any letter case', () => {
    const usdce = '0x20C000000000000000000000b9537d11c60E8b50';
    const tempo = (asset?: string) => offer({ protocol: 'mpp', scheme: 'charge', method: 'tempo', network: 'eip155:4217', ...(asset !== undefined && { asset }) });
    expect(payWayOf(tempo(usdce))).toBe('tempo');
    expect(payWayOf(tempo(usdce.toLowerCase()))).toBe('tempo');
    // Another token of Tempo, such as pathUSD, or none: never picked
    expect(payWayOf(tempo('0x20c0000000000000000000000000000000000000'))).toBeUndefined();
    expect(payWayOf(tempo())).toBeUndefined();
  });

  it('pays nothing else', () => {
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'eip155:8453', asset: '0x1' }))).toBeUndefined();
    expect(
      payWayOf(offer({ protocol: 'x402', scheme: 'batch-settlement', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })),
    ).toBeUndefined();
    expect(payWayOf(offer({ protocol: 'x402', scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }))).toBeUndefined();
    expect(payWayOf(offer({ protocol: 'mpp', scheme: 'charge', method: 'tempo', network: 'eip155:1' }))).toBeUndefined();
    expect(payWayOf(offer({ protocol: 'mpp', scheme: 'session', method: 'tempo', network: 'eip155:4217' }))).toBeUndefined();
  });
});
