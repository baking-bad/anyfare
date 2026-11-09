import { describe, expect, it } from 'vitest';
import type { ToolArgs } from '../src/cli.ts';
import { TOOLS } from '../src/tools/index.ts';
import { rateText } from '../src/tools/threeRoute.ts';
import type { PreparedCall } from '../src/tools/types.ts';
import { Stop, UsageError } from '../src/util.ts';
import { answerOf, fakeFetch, fixture } from './helpers.ts';

const TOKENS_URL = 'GET https://api.3route.io/v1/8453/tokens';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';

function prepare(args: ToolArgs, routes: Record<string, () => Response> = {}): Promise<PreparedCall> {
  const { fetch } = fakeFetch({ [TOKENS_URL]: () => answerOf('3route-tokens.json'), ...routes });
  return TOOLS[args.tool].prepare(args, { fetch });
}

async function usageOf(args: ToolArgs, routes?: Record<string, () => Response>): Promise<string> {
  try {
    await prepare(args, routes);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).message;
  }
  throw new Error('Expected a usage error');
}

const swap = (over: Partial<Extract<ToolArgs, { tool: '3route' }>> = {}): ToolArgs => ({
  tool: '3route',
  chain: 'base',
  from: 'USDC',
  to: 'WETH',
  amount: '1',
  ...over,
});

describe('the tools', () => {
  it('are listed in the order cmc, 3route, evidence, with a line that has no price', () => {
    expect(Object.keys(TOOLS)).toEqual(['cmc', '3route', 'evidence']);
    for (const tool of Object.values(TOOLS)) expect(tool.about).not.toMatch(/\$|[0-9]+\.[0-9]/);
  });
});

describe('cmc', () => {
  it('builds the request from a pair in any case', async () => {
    const prepared = await prepare({ tool: 'cmc', pair: 'btc/usd' });
    expect(prepared.request).toEqual({
      method: 'GET',
      url: 'https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD',
    });
    expect(prepared.summary).toBe('BTC in USD');
    expect(prepared.slow).toBe(false);
  });

  it.each(['BTC', 'BTC/', '/USD', 'BTC-USD', 'BTC/US D', 'BTC/USD/EUR', 'B$C/USD'])('refuses the pair %j', async (pair) => {
    const message = await usageOf({ tool: 'cmc', pair });
    expect(message).toContain('--pair');
    expect(message).toContain('BTC/USD');
  });

  it('formats the made-up answer: the best-ranked active asset, with the quote time', async () => {
    const prepared = await prepare({ tool: 'cmc', pair: 'BTC/USD' });
    expect(prepared.format(fixture('cmc-paid.json'))).toEqual([
      'Bitcoin Real (BTC)',
      'Price       12,345.68 USD',
      '24h         +2.50%',
      'Market cap  987,654,322',
      'Updated     2026-11-09T10:00:05.000Z',
    ]);
  });

  it('shows a negative change with its sign', async () => {
    const prepared = await prepare({ tool: 'cmc', pair: 'BTC/USD' });
    const answer = { data: { BTC: [{ name: 'X', symbol: 'BTC', quote: { USD: { percent_change_24h: -0.5 } } }] } };
    expect(prepared.format(answer)).toContain('24h         -0.50%');
  });

  it('prints - for every missing field', async () => {
    const prepared = await prepare({ tool: 'cmc', pair: 'BTC/USD' });
    expect(prepared.format({ data: [{ symbol: 'BTC' }] })).toEqual([
      '- (BTC)',
      'Price       -',
      '24h         -',
      'Market cap  -',
      'Updated     -',
    ]);
    expect(prepared.format({})).toEqual(['CoinMarketCap listed no active asset with the symbol BTC.']);
    expect(prepared.format('nonsense')).toHaveLength(1);
  });
});

describe('evidence', () => {
  it('builds a POST with a JSON body', async () => {
    const prepared = await prepare({ tool: 'evidence', account: 'anyfare.near' });
    expect(prepared.request).toEqual({
      method: 'POST',
      url: 'https://merchant-near.mikedotexe.com/v1/evidence/account',
      headers: { 'content-type': 'application/json' },
      body: '{"accountId":"anyfare.near"}',
    });
    expect(prepared.slow).toBe(true);
  });

  it('takes a named and an implicit account', async () => {
    await expect(prepare({ tool: 'evidence', account: 'a-b_c.d.near' })).resolves.toBeDefined();
    await expect(prepare({ tool: 'evidence', account: 'ab' })).resolves.toBeDefined();
    await expect(prepare({ tool: 'evidence', account: 'a'.repeat(64) })).resolves.toBeDefined();
  });

  it.each(['a', 'Anyfare.near', '.near', 'a..b', 'a b', 'a'.repeat(65), 'a.near.', '-a.near'])(
    'refuses the account %j',
    async (account) => {
      const message = await usageOf({ tool: 'evidence', account });
      expect(message).toContain('--account');
      expect(message).toContain('anyfare.near');
    },
  );

  it('formats the made-up answer, with the block and the observed time', async () => {
    const prepared = await prepare({ tool: 'evidence', account: 'anyfare.near' });
    expect(prepared.format(fixture('evidence-paid.json'))).toEqual([
      'Account     anyfare.near',
      'Balance     1.23456 NEAR',
      'Storage     4242 bytes',
      'Contract    no',
      'Block       123456789 (FakeBlockHashForTheTest1111111111111111111)',
      'Finality    final',
      'Observed    2026-11-09T10:15:00.000Z',
    ]);
  });

  it('shows a contract when the code hash is not the empty one', async () => {
    const prepared = await prepare({ tool: 'evidence', account: 'anyfare.near' });
    const answer = { account: { codeHash: 'FakeCodeHash11111111111111111111111111' } };
    expect(prepared.format(answer)).toContain('Contract    yes');
  });

  it('prints - for every missing field', async () => {
    const prepared = await prepare({ tool: 'evidence', account: 'anyfare.near' });
    expect(prepared.format({})).toEqual([
      'Account     -',
      'Balance     -',
      'Storage     -',
      'Contract    -',
      'Block       - (-)',
      'Finality    -',
      'Observed    -',
    ]);
  });
});

describe('3route', () => {
  it('builds the quote request from symbols in any case', async () => {
    const prepared = await prepare(swap({ from: 'usdc', to: 'weth', amount: '1.5' }));
    expect(prepared.request).toEqual({
      method: 'GET',
      url: `https://api.3route.io/v1/8453/quote?src=${USDC}&dst=${WETH}&amount=1500000&includeBlockNumber=true`,
    });
    expect(prepared.summary).toBe('1.5 USDC → WETH on Base');
    expect(prepared.slow).toBe(false);
  });

  it('takes the chain by name or by id', async () => {
    const routes = { 'GET https://api.3route.io/v1/1/tokens': () => answerOf('3route-tokens.json') };
    const prepared = await prepare(swap({ chain: 'ethereum' }), routes);
    expect(prepared.request.url).toContain('/v1/1/quote?');
    expect(prepared.summary).toContain('on Ethereum');
    const byId = await prepare(swap({ chain: '8453' }));
    expect(byId.request.url).toContain('/v1/8453/quote?');
  });

  it('refuses an unknown chain', async () => {
    const message = await usageOf(swap({ chain: 'solana' }));
    expect(message).toContain('--chain');
    expect(message).toContain('base');
  });

  it('takes the native token by its symbol', async () => {
    const prepared = await prepare(swap({ from: 'eth', to: 'USDC', amount: '0.5' }));
    expect(prepared.request.url).toContain('src=0x0000000000000000000000000000000000000000');
    expect(prepared.request.url).toContain('amount=500000000000000000');
  });

  it('takes a typed address as typed, with the symbol from the list', async () => {
    const typed = '0x4200000000000000000000000000000000000006'.toUpperCase().replace('0X', '0x');
    const prepared = await prepare(swap({ to: typed }));
    expect(prepared.request.url).toContain(`dst=${typed}`);
    expect(prepared.summary).toBe('1 USDC → WETH on Base');
  });

  it('reads the symbol and decimals of an address the list does not have', async () => {
    const other = '0x1111111111111111111111111111111111111111';
    const { fetch, calls } = fakeFetch({
      [TOKENS_URL]: () => answerOf('3route-tokens.json'),
      [`GET https://api.3route.io/v1/8453/tokens/${other}`]: () =>
        new Response(JSON.stringify({ address: other, symbol: 'MADEUP', decimals: 8 })),
    });
    const prepared = await TOOLS['3route'].prepare(swap({ from: other, amount: '0.00000001' }), { fetch });
    expect(prepared.request.url).toContain('amount=1');
    expect(prepared.summary).toBe('0.00000001 MADEUP → WETH on Base');
    expect(calls).toHaveLength(2);
  });

  it('stops when an unlisted address is unknown to 3Route too', async () => {
    const other = '0x2222222222222222222222222222222222222222';
    const failing = { [`GET https://api.3route.io/v1/8453/tokens/${other}`]: () => new Response('{}', { status: 404 }) };
    await expect(prepare(swap({ to: other }), failing)).rejects.toBeInstanceOf(Stop);
    await expect(prepare(swap({ to: other }), failing)).rejects.toThrow(other);
  });

  it('refuses an unknown symbol, and says where to look', async () => {
    const message = await usageOf(swap({ to: 'NOPE' }));
    expect(message).toContain('--to');
    expect(message).toContain('NOPE');
    expect(message).toContain('token list');
  });

  it('refuses more decimals than the token has', async () => {
    const message = await usageOf(swap({ amount: '1.0000001' }));
    expect(message).toContain('--amount');
    expect(message).toContain('at most 6');
  });

  it('refuses zero and refuses text', async () => {
    expect(await usageOf(swap({ amount: '0' }))).toContain('more than zero');
    expect(await usageOf(swap({ amount: '0.000000' }))).toContain('more than zero');
    expect(await usageOf(swap({ amount: 'one' }))).toContain('--amount');
  });

  it('refuses the same token twice, by symbol or by address', async () => {
    expect(await usageOf(swap({ to: 'usdc' }))).toContain('same token');
    expect(await usageOf(swap({ to: USDC.toUpperCase().replace('0X', '0x') }))).toContain('same token');
  });

  it('stops when the token list is not available', async () => {
    const { fetch } = fakeFetch({ [TOKENS_URL]: () => new Response('{}', { status: 500 }) });
    await expect(TOOLS['3route'].prepare(swap(), { fetch })).rejects.toThrow("3Route's token list");
  });

  it('formats the made-up answer: amounts, both rates, gas and block', async () => {
    const prepared = await prepare(swap());
    expect(prepared.format(fixture('3route-paid.json'))).toEqual([
      '1 USDC → 0.00025 WETH',
      'Rate        1 USDC = 0.00025 WETH',
      '            1 WETH = 4000 USDC',
      'Gas         150000',
      'Block 12345678 on Base',
    ]);
  });

  it('cuts the destination amount to 8 significant fractional digits, never rounding up', async () => {
    const prepared = await prepare(swap());
    const answer = { srcAmount: '1000000', dstAmount: '123456789999999999', gas: 1, blockNumber: 1 };
    expect(prepared.format(answer)[0]).toBe('1 USDC → 0.12345678 WETH');
    const small = { srcAmount: '1000000', dstAmount: '245123456789', gas: 1, blockNumber: 1 };
    expect(prepared.format(small)[0]).toBe('1 USDC → 0.00000024512345 WETH');
  });

  it('prints - for every missing field', async () => {
    const prepared = await prepare(swap());
    expect(prepared.format({})).toEqual(['1 USDC → - WETH', 'Gas         -', 'Block - on Base']);
  });
});

describe('rateText', () => {
  it('computes exact values with bigint math', () => {
    // 3 of a token with 6 decimals for 3 / 7 of a token with 18 decimals
    const src = { amount: 3_000_000n, decimals: 6 };
    const dst = { amount: 428_571_428_571_428_571n, decimals: 18 };
    expect(rateText(src, dst)).toBe('0.14285714');
    expect(rateText(dst, src)).toBe('7');
  });

  it('is exact for round numbers and cuts instead of rounding', () => {
    expect(rateText({ amount: 1_000_000n, decimals: 6 }, { amount: 250_000_000_000_000n, decimals: 18 })).toBe('0.00025');
    expect(rateText({ amount: 250_000_000_000_000n, decimals: 18 }, { amount: 1_000_000n, decimals: 6 })).toBe('4000');
    expect(rateText({ amount: 3n, decimals: 0 }, { amount: 2n, decimals: 0 })).toBe('0.66666666');
    expect(rateText({ amount: 3n, decimals: 0 }, { amount: 10n, decimals: 0 })).toBe('3.33333333');
  });

  it('has no rate for a zero amount', () => {
    expect(rateText({ amount: 0n, decimals: 6 }, { amount: 1n, decimals: 6 })).toBe('-');
  });
});
