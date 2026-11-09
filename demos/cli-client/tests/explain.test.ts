import { describe, expect, it } from 'vitest';
import { checkQuote, routingLink } from '../src/anyfare.ts';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { explainLines, planFailure, readPlan } from '../src/explain.ts';
import type { Plan } from '../src/explain.ts';
import { createStyle } from '../src/style.ts';
import { TOOLS } from '../src/tools/index.ts';
import { PassThrough } from 'node:stream';
import type { ToolArgs } from '../src/cli.ts';
import { answerOf, captureIo, fakeFetch, fixture } from './helpers.ts';

const PAY = 'https://pay.example.test';
const ENV = { ANYFARE_PAY_URL: PAY };
const plain = createStyle(new PassThrough());

const CMC = 'https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD';
const EVIDENCE = 'https://merchant-near.mikedotexe.com/v1/evidence/account';
const ROUTE_QUOTE =
  'https://api.3route.io/v1/8453/quote?src=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&dst=0x4200000000000000000000000000000000000006&amount=1000000&includeBlockNumber=true';

const checkUrl = (target: string) => `${PAY}/_/check?url=${encodeURIComponent(target)}`;

type Routes = Record<string, () => Response>;

const cmcRoutes = (): Routes => ({
  [`GET ${CMC}`]: () => answerOf('cmc-402.json'),
  [`GET ${checkUrl(CMC)}`]: () => answerOf('check-cmc.json'),
  [`GET ${routingLink(PAY, CMC)}`]: () => answerOf('anyfare-402-cmc.json'),
});

const evidenceRoutes = (): Routes => ({
  [`POST ${EVIDENCE}`]: () => answerOf('evidence-402.json'),
  [`POST ${routingLink(PAY, EVIDENCE)}`]: () => answerOf('anyfare-402-evidence.json'),
});

const routeRoutes = (): Routes => ({
  'GET https://api.3route.io/v1/8453/tokens': () => answerOf('3route-tokens.json'),
  [`GET ${ROUTE_QUOTE}`]: () => answerOf('3route-402.json'),
  [`GET ${checkUrl(ROUTE_QUOTE)}`]: () =>
    Response.json({
      payable: true,
      target: ROUTE_QUOTE,
      price: { amount: '0.001', currency: 'USD', asset: 'base-usdc', network: 'eip155:8453' },
      quote: { amount: '0.0012', fee: '0.0002', currency: 'USD' },
      link: routingLink(PAY, ROUTE_QUOTE),
    }),
  [`GET ${routingLink(PAY, ROUTE_QUOTE)}`]: () => answerOf('anyfare-402-cmc.json'),
});

async function planFor(args: ToolArgs, routes: Routes, env: Record<string, string> = ENV) {
  const { fetch, calls } = fakeFetch(routes);
  const prepared = await TOOLS[args.tool].prepare(args, { fetch });
  const plan = await readPlan({ fetch, config: loadConfig(env), prepared });
  return { plan, calls };
}

const text = (plan: Plan, payWay?: Parameters<typeof explainLines>[1]) => explainLines(plan, payWay, plain).join('\n');

const cmcArgs: ToolArgs = { tool: 'cmc', pair: 'BTC/USD' };
const evidenceArgs: ToolArgs = { tool: 'evidence', account: 'anyfare.near' };
const routeArgs: ToolArgs = { tool: '3route', chain: 'base', from: 'USDC', to: 'WETH', amount: '1' };

describe('routingLink', () => {
  it('puts the target without https:// after the pay host', () => {
    expect(routingLink('https://pay.example.test/', 'https://api.3route.io/v1/8453/quote?src=a')).toBe(
      'https://pay.example.test/api.3route.io/v1/8453/quote?src=a',
    );
  });
});

describe('checkQuote', () => {
  it('keeps a missing currency missing', async () => {
    const { fetch } = fakeFetch({
      [`GET ${checkUrl(CMC)}`]: () =>
        Response.json({ payable: true, target: CMC, price: { amount: '0.01' }, quote: { amount: '0.011', fee: '0.001' } }),
    });
    const check = await checkQuote(fetch, PAY, CMC);
    if (!check.payable) throw new Error('Expected a quote');
    expect(check.price.currency).toBeUndefined();
    expect(check.quote.currency).toBeUndefined();
  });
});

describe('readPlan', () => {
  it('reads the API, then /_/check, then the routing link, with the same call', async () => {
    const { plan, calls } = await planFor(cmcArgs, cmcRoutes());
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${CMC}`,
      `GET ${checkUrl(CMC)}`,
      `GET ${routingLink(PAY, CMC)}`,
    ]);
    expect(plan.link).toBe(routingLink(PAY, CMC));
    expect(planFailure(plan)).toBeUndefined();
  });

  it('skips /_/check for a POST and sends the same body to both', async () => {
    const { plan, calls } = await planFor(evidenceArgs, evidenceRoutes());
    expect(plan.check.kind).toBe('skipped');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${EVIDENCE}`,
      `POST ${routingLink(PAY, EVIDENCE)}`,
    ]);
    for (const call of calls) {
      expect(call.body).toBe('{"accountId":"anyfare.near"}');
      expect(call.headers['content-type']).toBe('application/json');
      expect(Object.keys(call.headers).sort()).toEqual(['content-type', 'user-agent']);
    }
  });
});

describe('explainLines', () => {
  it('marks the option Anyfare pays in the API\'s own 402, and lists the rest', async () => {
    const { plan } = await planFor(cmcArgs, cmcRoutes());
    const lines = explainLines(plan, undefined, plain);
    expect(lines[0]).toBe('▸ What CoinMarketCap asks, without Anyfare');
    expect(lines[1]).toBe('  402 Payment Required, x402 version 2. 7 options:');
    const marked = lines.filter((line) => line.includes('← Anyfare pays this one'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('0.01 USDC on Base');
    expect(marked[0]).not.toContain('the only option');
    expect(lines.filter((line) => line.includes('on BNB Chain'))).toHaveLength(6);
    expect(text(plan)).toContain('0.01 USD1 on BNB Chain');
    expect(text(plan)).toContain('0.01 USDT on BNB Chain');
    expect(text(plan)).toContain('0.01 United Stables on BNB Chain');
  });

  it("lists Anyfare's options with the --pay value of each", async () => {
    const { plan } = await planFor(cmcArgs, cmcRoutes());
    const out = text(plan);
    expect(out).toContain('▸ What Anyfare asks for the same call');
    expect(out).toMatch(/\$0\.011 of Credits\s+--pay credits/);
    expect(out).toMatch(/0\.011 USDC on Base\s+exact \(eip3009\)\s+--pay base/);
    expect(out).toMatch(/0\.011 USDC on NEAR\s+exact\s+--pay near/);
    expect(out).toMatch(/0\.011 USDC\.e on Tempo \(MPP charge\)\s+--pay tempo/);
    expect(out).toMatch(/0\.011 USDC on Solana\s+exact\s+Anyfare takes it; this app doesn't pay it/);
    expect(out).not.toContain('you pay this one');
  });

  it("shows Anyfare's quote from /_/check and the cap", async () => {
    const { plan } = await planFor(cmcArgs, cmcRoutes());
    const out = text(plan);
    expect(out).toContain("▸ Anyfare's quote, from GET /_/check");
    expect(out).toMatch(/The API's price\s+\$0\.01 in USDC on Base/);
    expect(out).toMatch(/Anyfare's fee\s+\$0\.001/);
    expect(out).toMatch(/You pay\s+\$0\.011/);
    expect(out).toContain('Your cap, MAX_PAYMENT_USD, is $0.02. This quote is within it.');
  });

  it("keeps the /_/check quote, and names the routing link's 402 price when it differs", async () => {
    const quote = (amount: string) => () =>
      Response.json({
        payable: true,
        target: CMC,
        price: { amount: '0.008', currency: 'USD', asset: 'base-usdc', network: 'eip155:8453' },
        quote: { amount, fee: '0.001', currency: 'USD' },
        link: routingLink(PAY, CMC),
      });
    // Made up: /_/check quotes $0.009 while the 402 of the fixture asks $0.011
    const { plan } = await planFor(cmcArgs, { ...cmcRoutes(), [`GET ${checkUrl(CMC)}`]: quote('0.009') });
    const out = text(plan);
    expect(out).toMatch(/You pay\s+\$0\.009\n/);
    expect(out).toContain("  Anyfare's 402 for the same call asks $0.011 of Credits, not $0.009.");
    const same = await planFor(cmcArgs, { ...cmcRoutes(), [`GET ${checkUrl(CMC)}`]: quote('0.011') });
    expect(text(same.plan)).not.toContain("Anyfare's 402 for the same call");
  });

  it("judges the cap on the routing link's 402 price when it is the higher one", async () => {
    const quote = () =>
      Response.json({
        payable: true,
        target: CMC,
        price: { amount: '0.008', currency: 'USD', asset: 'base-usdc', network: 'eip155:8453' },
        quote: { amount: '0.009', fee: '0.001', currency: 'USD' },
        link: routingLink(PAY, CMC),
      });
    // Made up: /_/check quotes $0.009, the 402 of the fixture asks $0.011, and the cap is $0.01
    const routes = { ...cmcRoutes(), [`GET ${checkUrl(CMC)}`]: quote };
    const { plan } = await planFor(cmcArgs, routes, { ...ENV, MAX_PAYMENT_USD: '0.01' });
    expect(text(plan)).toContain('Your cap, MAX_PAYMENT_USD, is $0.01. This quote is over it');
  });

  it('says when the quote is over the cap', async () => {
    const { plan } = await planFor(cmcArgs, cmcRoutes(), { ...ENV, MAX_PAYMENT_USD: '0.01' });
    expect(text(plan)).toContain('Your cap, MAX_PAYMENT_USD, is $0.01. This quote is over it');
  });

  it('marks the option the buyer pays when a way is given', async () => {
    const { plan } = await planFor(cmcArgs, cmcRoutes());
    for (const [way, needle] of [
      ['credits', 'of Credits'],
      ['near', 'USDC on NEAR'],
      ['base', 'USDC on Base'],
      ['tempo', 'USDC.e on Tempo'],
    ] as const) {
      const marked = explainLines(plan, way, plain).filter((line) => line.includes('← you pay this one'));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain(needle);
      expect(marked[0]).toContain(`--pay ${way}`);
    }
  });

  it('says so when Anyfare offers no option for the chosen way', async () => {
    const { plan } = await planFor(cmcArgs, cmcRoutes());
    if (plan.anyfare.kind !== 'ok') throw new Error('Expected an answer');
    const withoutBase = {
      ...plan,
      anyfare: {
        kind: 'ok',
        value: { ...plan.anyfare.value, offers: plan.anyfare.value.offers.filter((offer) => offer.network !== 'eip155:8453') },
      },
    } satisfies Plan;
    const out = text(withoutBase, 'base');
    expect(out).toContain('Anyfare offers no USDC on Base for this call now.');
    expect(out).not.toContain('← you pay this one');
  });

  it('lists a batch-settlement option as skipped and does not mark it', async () => {
    const { plan } = await planFor(routeArgs, routeRoutes());
    const lines = explainLines(plan, undefined, plain);
    const skipped = lines.filter((line) => line.includes('offered, skipped: Anyfare pays exact options only'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('batch-settlement');
    expect(skipped[0]).not.toContain('←');
    const marked = lines.filter((line) => line.includes('← Anyfare pays this one'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('0.001 USDC on Base');
    expect(marked[0]).toContain('exact');
    expect(text(plan)).toContain('0.001 USDC.e on Tempo (MPP charge)');
    expect(text(plan)).toContain('0.001 USDC on Etherlink');
  });

  it('for a POST, marks the only option Anyfare can pay and takes the fee from the credits price', async () => {
    const { plan } = await planFor(evidenceArgs, evidenceRoutes());
    const out = text(plan);
    const marked = out.split('\n').filter((line) => line.includes('← Anyfare pays this one'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('0.001 USDC on NEAR');
    expect(marked[0]).toContain('the only option it can pay');
    expect(out).toContain("▸ Anyfare's quote, from the routing link's 402");
    expect(out).toContain("GET /_/check probes with GET and no body");
    expect(out).toMatch(/The API's price\s+\$0\.001 in USDC on NEAR/);
    expect(out).toMatch(/Anyfare's fee\s+\$0\.001/);
    expect(out).toMatch(/You pay\s+\$0\.002/);
  });

  it('marks nothing for a POST when several options can be paid', async () => {
    const { plan } = await planFor(evidenceArgs, evidenceRoutes());
    if (plan.api.kind !== 'ok') throw new Error('Expected an answer');
    const [near] = plan.api.value.offers;
    if (near === undefined) throw new Error('Expected an offer');
    const base = { ...near, network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
    const two = { ...plan, api: { kind: 'ok', value: { ...plan.api.value, offers: [near, base] } } } satisfies Plan;
    const out = text(two);
    expect(out).not.toContain('← Anyfare pays this one');
    expect(out).toContain('Anyfare can pay more than one of these');
    expect(out).toMatch(/The API's price\s+not known/);
  });

  it('says so when the API answers something other than a 402', async () => {
    const routes = { ...cmcRoutes(), [`GET ${CMC}`]: () => new Response('{}', { status: 200 }) };
    const { plan } = await planFor(cmcArgs, routes);
    expect(text(plan)).toContain('The API answered 200 without asking for a payment.');
  });
});

describe('Anyfare not answering', () => {
  const apiOnly = (): Routes => ({ [`GET ${CMC}`]: () => answerOf('cmc-402.json') });

  it('keeps the API part and says what failed in the other two', async () => {
    const { plan } = await planFor(cmcArgs, apiOnly());
    expect(plan.check.kind).toBe('failed');
    expect(plan.anyfare.kind).toBe('failed');
    const out = text(plan);
    expect(out).toContain('0.01 USDC on Base');
    expect(out).toContain('Anyfare did not answer: Could not reach pay.example.test: ENOTFOUND');
    expect(planFailure(plan)).toBe(`Anyfare at ${PAY} did not answer.`);
  });

  it('exits 1 with the API part on stdout and one ✘ line on stderr', async () => {
    const { fetch } = fakeFetch(apiOnly());
    const fake = captureIo(fetch, ENV);
    expect(await runCli(['explain', '--tool', 'cmc'], fake.io)).toBe(1);
    expect(fake.out()).toContain('▸ What CoinMarketCap asks, without Anyfare');
    expect(fake.out()).toContain('0.01 USDC on Base');
    expect(fake.err()).toBe(`✘ Anyfare at ${PAY} did not answer.\n`);
  });

  it('exits 1 when the API itself does not answer', async () => {
    const fake = captureIo(fakeFetch({}).fetch, ENV);
    expect(await runCli(['explain', '--tool', 'cmc'], fake.io)).toBe(1);
    expect(fake.err().trim().split('\n')).toHaveLength(1);
    expect(fake.err()).toContain('✘ The API did not answer: Could not reach pro-api.coinmarketcap.com');
  });

  it('exits 1 with the reason when /_/check says the call is not payable', async () => {
    const routes = { ...cmcRoutes(), [`GET ${checkUrl(CMC)}`]: () => answerOf('check-not-payable.json') };
    const fake = captureIo(fakeFetch(routes).fetch, ENV);
    expect(await runCli(['explain', '--tool', 'cmc'], fake.io)).toBe(1);
    expect(fake.err()).toBe('✘ Anyfare cannot pay this call: The target does not answer a GET with a payment request\n');
  });
});

describe('the explain command', () => {
  it('exits 0 and prints the title, the two addresses and the three blocks', async () => {
    const fake = captureIo(fakeFetch(cmcRoutes()).fetch, ENV);
    expect(await runCli(['explain', '--tool', 'cmc'], fake.io)).toBe(0);
    expect(fake.err()).toBe('');
    const out = fake.out();
    expect(out).toContain('CoinMarketCap: BTC in USD');
    expect(out).toContain(`Anyfare   ${PAY}`);
    expect(out).toContain(`The API   ${CMC}`);
    const steps = out.split('\n').filter((line) => line.startsWith('▸'));
    expect(steps).toEqual([
      '▸ What CoinMarketCap asks, without Anyfare',
      '▸ What Anyfare asks for the same call',
      "▸ Anyfare's quote, from GET /_/check",
    ]);
  });

  it('works for the evidence API, a POST', async () => {
    const fake = captureIo(fakeFetch(evidenceRoutes()).fetch, ENV);
    expect(await runCli(['explain', '--tool', 'evidence'], fake.io)).toBe(0);
    expect(fake.out()).toContain('What the evidence API asks, without Anyfare');
  });

  it('works for 3Route and reads the token list live', async () => {
    const fake = captureIo(fakeFetch(routeRoutes()).fetch, ENV);
    expect(await runCli(['explain', '--tool', '3route'], fake.io)).toBe(0);
    expect(fake.out()).toContain('3Route: 1 USDC → WETH on Base');
  });

  it('refuses bad input with exit 2 before any request', async () => {
    const { fetch, calls } = fakeFetch(cmcRoutes());
    const fake = captureIo(fetch, ENV);
    expect(await runCli(['explain', '--tool', 'cmc', '--pair', 'BTC'], fake.io)).toBe(2);
    expect(fake.err()).toContain('--pair');
    expect(calls).toHaveLength(0);
  });

  it('reads the settings only when it needs them', async () => {
    const fake = captureIo(fakeFetch({}).fetch, { MAX_PAYMENT_USD: 'lots' });
    expect(await runCli(['--help'], fake.io)).toBe(0);
    expect(await runCli(['explain', '--tool', 'cmc'], fake.io)).toBe(1);
    expect(fake.err()).toContain('MAX_PAYMENT_USD is not a valid amount');
  });

  it('keeps the recorded answers dated today', () => {
    for (const name of ['cmc-402.json', '3route-402.json', 'evidence-402.json']) {
      expect(fixture(name).note).toContain('Recorded 2026-11-09 from an unpaid request');
    }
  });
});
