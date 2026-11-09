import { describe, expect, it, vi } from 'vitest';

import { createFakeClock, defaultOneClickTokens, startFakeOneClick } from '@anyfare/testing';

import {
  AmbiguousTokenError, createOneClickClient, createTokenCatalog, OneClickUnavailableError, UnknownTokenError, type OneClickToken, type StaleTokenList,
} from '../src/index.js';

const down = () => new OneClickUnavailableError('server_error', { method: 'GET', path: '/v0/tokens', status: 503 });

const setup = (tokens: () => Promise<readonly OneClickToken[]> = async () => defaultOneClickTokens) => {
  const clock = createFakeClock('2026-11-09T12:00:00.000Z');
  const client = { tokens: vi.fn(tokens) };
  const stale: StaleTokenList[] = [];
  const catalog = createTokenCatalog({ client, clock, onStale: item => stale.push(item) });

  return { clock, client, stale, catalog };
};

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
  try {
    await call();
  }
  catch (error) {
    return error as Error;
  }
  throw new Error('Expected a failure');
};

describe('the token catalog', () => {
  it('resolves a symbol without case', async () => {
    const { catalog } = setup();

    expect(await catalog.resolve({ blockchain: 'base', token: 'usdc' })).toMatchObject({ assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6 });
    expect(await catalog.resolve({ blockchain: 'near', token: 'WNEAR' })).toMatchObject({ assetId: 'nep141:wrap.near', decimals: 24 });
    expect(await catalog.resolve({ blockchain: 'sol', token: 'SOL' })).toMatchObject({ assetId: 'nep141:sol.omft.near', decimals: 9 });
  });

  it('resolves a 0x contract address in any case, and another address exactly', async () => {
    const { catalog } = setup();

    expect((await catalog.resolve({ blockchain: 'base', token: '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' })).symbol).toBe('USDC');
    expect((await catalog.resolve({ blockchain: 'sol', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })).symbol).toBe('USDC');
    expect(await failure(() => catalog.resolve({ blockchain: 'sol', token: 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v' }))).toBeInstanceOf(UnknownTokenError);
    // The address of a token on another blockchain
    expect(await failure(() => catalog.resolve({ blockchain: 'arb', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }))).toBeInstanceOf(UnknownTokenError);
  });

  it('resolves a 1Click asset ID', async () => {
    const { catalog } = setup();

    expect((await catalog.resolve({ blockchain: 'btc', token: 'nep141:btc.omft.near' })).symbol).toBe('BTC');
    expect((await catalog.resolve({ blockchain: 'base', token: 'nep141:base.omft.near' })).symbol).toBe('ETH');
  });

  it('says which token is unknown, and how to name one', async () => {
    const { catalog } = setup();
    const error = await failure(() => catalog.resolve({ blockchain: 'base', token: 'DOGE' }));

    expect(error).toBeInstanceOf(UnknownTokenError);
    expect(error).toMatchObject({ code: 'unknown_token', blockchain: 'base', token: 'DOGE' });
    expect(error.message).toBe('No token "DOGE" on base. Send its symbol, its contract address or its 1Click asset ID');
    expect(await failure(() => catalog.resolve({ blockchain: 'tron', token: 'USDC' }))).toBeInstanceOf(UnknownTokenError);
    expect((await failure(() => catalog.resolve({ blockchain: 'base', token: 'x'.repeat(1_000) }))).message.length).toBeLessThan(250);
  });

  it('lists the matches of an ambiguous symbol, and resolves either by its address', async () => {
    const { catalog } = setup();
    const error = await failure(() => catalog.resolve({ blockchain: 'hypercore', token: 'USDC' }));

    expect(error).toBeInstanceOf(AmbiguousTokenError);
    expect(error).toMatchObject({ code: 'ambiguous_token', candidates: ['0x6d1e7cde53ba9467b783cb7c530ce054', '0xb88339CB7199b77E23DB6E890353E22632Ba630f'] });
    expect(error.message).toBe('2 tokens on hypercore match "USDC": 0x6d1e7cde53ba9467b783cb7c530ce054, 0xb88339CB7199b77E23DB6E890353E22632Ba630f. Send one of these instead');
    expect((await catalog.resolve({ blockchain: 'hypercore', token: '0xb88339cb7199b77e23db6e890353e22632ba630f' })).decimals).toBe(6);
    expect((await catalog.resolve({ blockchain: 'hypercore', token: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054' })).decimals).toBe(8);
  });

  it('names a match without a contract address by its asset ID', async () => {
    const twoCoins = [...defaultOneClickTokens, { ...defaultOneClickTokens.find(token => token.assetId === 'nep141:btc.omft.near')!, assetId: '1cs_v1:btc:native:coin' }];
    const { catalog } = setup(async () => twoCoins);

    expect(await failure(() => catalog.resolve({ blockchain: 'btc', token: 'btc' }))).toMatchObject({ candidates: ['nep141:btc.omft.near', '1cs_v1:btc:native:coin'] });
  });

  it('lists the tokens on a blockchain', async () => {
    const { catalog } = setup();

    expect((await catalog.list('near')).map(token => token.symbol)).toEqual(['USDC', 'wNEAR', 'tUSDC']);
    expect(await catalog.list('tron')).toEqual([]);
  });

  it('fetches the list once and keeps it for five minutes', async () => {
    const { catalog, client, clock } = setup();
    await catalog.resolve({ blockchain: 'base', token: 'USDC' });
    await catalog.list('sol');
    clock.advance(299_999);
    await catalog.resolve({ blockchain: 'base', token: 'ETH' });

    expect(client.tokens).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await catalog.list('base');
    expect(client.tokens).toHaveBeenCalledTimes(2);
  });

  it('answers from the older list for up to an hour while refreshes fail, and says so once per failed refresh', async () => {
    let fail = false;
    const { catalog, client, clock, stale } = setup(async () => {
      if (fail)
        throw down();
      return defaultOneClickTokens;
    });
    await catalog.list('base');
    fail = true;
    clock.advance(300_000);

    expect((await catalog.resolve({ blockchain: 'base', token: 'USDC' })).symbol).toBe('USDC');
    expect(stale).toEqual([{ error: expect.any(OneClickUnavailableError), ageMs: 300_000 }]);
    clock.advance(3_300_000);
    expect(await catalog.list('base')).toHaveLength(2);
    expect(stale.map(item => item.ageMs)).toEqual([300_000, 3_600_000]);
    expect(client.tokens).toHaveBeenCalledTimes(3);

    clock.advance(1);
    expect(await failure(() => catalog.list('base'))).toBeInstanceOf(OneClickUnavailableError);
    fail = false;
    expect(await catalog.list('base')).toHaveLength(2);
    expect(stale).toHaveLength(2);
  });

  it('throws when it has no list at all, and tries again on the next call', async () => {
    let fail = true;
    const { catalog, client, stale } = setup(async () => {
      if (fail)
        throw down();
      return defaultOneClickTokens;
    });

    expect(await failure(() => catalog.resolve({ blockchain: 'base', token: 'USDC' }))).toMatchObject({ code: 'oneclick_unavailable', reason: 'server_error' });
    fail = false;
    expect((await catalog.resolve({ blockchain: 'base', token: 'USDC' })).symbol).toBe('USDC');
    expect(client.tokens).toHaveBeenCalledTimes(2);
    expect(stale).toEqual([]);
  });

  it('shares one fetch between concurrent callers', async () => {
    let release: (tokens: readonly OneClickToken[]) => void = () => undefined;
    const { catalog, client } = setup(() => new Promise(resolve => {
      release = resolve;
    }));
    const pending = Promise.all([
      catalog.resolve({ blockchain: 'base', token: 'USDC' }),
      catalog.resolve({ blockchain: 'sol', token: 'SOL' }),
      catalog.list('near'),
    ]);
    release(defaultOneClickTokens);
    const [usdc, sol, near] = await pending;

    expect(client.tokens).toHaveBeenCalledTimes(1);
    expect([usdc.symbol, sol.symbol, near.length]).toEqual(['USDC', 'SOL', 3]);
  });

  it('shares one failed fetch too, and tells of it once', async () => {
    let fail = false;
    const { catalog, client, clock, stale } = setup(async () => {
      if (fail)
        throw down();
      return defaultOneClickTokens;
    });
    await catalog.list('base');
    fail = true;
    clock.advance(300_000);
    await Promise.all([catalog.list('base'), catalog.list('sol'), catalog.resolve({ blockchain: 'near', token: 'USDC' })]);

    expect(client.tokens).toHaveBeenCalledTimes(2);
    expect(stale).toHaveLength(1);
  });

  it('reads the list from 1Click through the client', async () => {
    const oneClick = await startFakeOneClick();
    try {
      const catalog = createTokenCatalog({ client: createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 }), clock: createFakeClock('2026-11-09T12:00:00.000Z') });

      expect((await catalog.resolve({ blockchain: 'arb', token: 'USDC' })).assetId).toBe('nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near');
      expect((await catalog.resolve({ blockchain: 'eth', token: 'usdc' })).contractAddress).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      expect(oneClick.requests).toHaveLength(1);
    }
    finally {
      await oneClick.close();
    }
  });
});
