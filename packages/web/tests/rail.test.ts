import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GET } from '../app/logos/[kind]/[file]/route';
import { logoSvg, networkLogo, tokenLogo } from '../src/brand/logos';
import { Rail, RailIcon, railToken } from '../src/components/Rail';

// React hints the images it renders as preloads, which a page puts in its head: the markup is what follows them
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element).replaceAll(/<link rel="preload" as="image" href="[^"]+"\/>/g, '');
const img = (path: string, net = false): string => `<img${net ? ' class="net"' : ''} src="${path}" alt="" decoding="async"/>`;

describe('the icon of a way of paying', () => {
  it('is the network logo alone without a token', () => {
    expect(html(createElement(RailIcon, { rail: 'base' }))).toBe(`<span class="coin s16" aria-hidden="true">${img('/logos/networks/base.svg')}</span>`);
  });

  it('is the token logo with the network logo at its corner', () => {
    expect(html(createElement(RailIcon, { rail: 'near', token: 'USDC', size: 32 })))
      .toBe(`<span class="coin pair s32 near" aria-hidden="true">${img('/logos/tokens/usdc.svg')}${img('/logos/networks/near.svg', true)}</span>`);
  });

  it('falls back to the first letter or digit of a token or network the site has no logo of', () => {
    expect(html(createElement(RailIcon, { rail: 'gnosis', token: 'xDAI' }))).toContain('<i>X</i><i class="net">G</i>');
    expect(html(createElement(RailIcon, { rail: 'base', token: '.pathUSD' }))).toContain(`<i>P</i>${img('/logos/networks/base.svg', true)}`);
  });

  it('is the "$" alone for Credits, even with a token', () => {
    expect(html(createElement(RailIcon, { rail: 'credits', token: 'Credits', size: 24 }))).toBe('<span class="coin s24" aria-hidden="true"><i>$</i></span>');
  });

  it('marks a chip with a pair, and keeps its label', () => {
    expect(html(createElement(Rail, { rail: 'solana', token: 'SOL', label: 'SOL on Solana' })))
      .toBe(`<span class="rail pair"><span class="coin pair s16" aria-hidden="true">${img('/logos/tokens/sol.svg')}${img('/logos/networks/solana.svg', true)}</span>SOL on Solana</span>`);
    expect(html(createElement(Rail, { rail: 'near' }))).toBe(`<span class="rail near"><span class="coin s16 near" aria-hidden="true">${img('/logos/networks/near.svg')}</span>NEAR</span>`);
  });
});

describe('the token of a way of paying', () => {
  it('is USDC on the x402 chains and USDC.e on Tempo, none for Credits or an unknown network', () => {
    expect(['near', 'base', 'solana', 'tempo', 'credits', 'bitcoin', 'constructor'].map(railToken)).toEqual(['USDC', 'USDC', 'USDC', 'USDC.e', undefined, undefined, undefined]);
  });
});

describe('the logos', () => {
  it('has one for each way of paying and each top-up network', () => {
    expect(['near', 'base', 'solana', 'tempo', 'arbitrum', 'ethereum', 'bitcoin'].map(networkLogo)).toEqual(
      ['near', 'base', 'solana', 'tempo', 'arbitrum', 'ethereum', 'bitcoin'].map(network => `/logos/networks/${network}.svg`));
    expect(networkLogo('credits')).toBeUndefined();
    expect(networkLogo('toString')).toBeUndefined();
  });

  it('finds a token by its symbol, a bridged or wrapped one by the original, and ARB by Arbitrum', () => {
    expect(['USDC', 'USDC.e', 'usdt', 'SOL', 'wNEAR', 'ETH', 'WBTC'].map(tokenLogo)).toEqual(
      ['usdc', 'usdc', 'usdt', 'sol', 'near', 'eth', 'btc'].map(token => `/logos/tokens/${token}.svg`));
    expect(tokenLogo('ARB')).toBe('/logos/networks/arbitrum.svg');
    expect(tokenLogo('pathUSD')).toBeUndefined();
    expect(tokenLogo('constructor')).toBeUndefined();
  });

  it('holds only shapes: no script, style, link, image or event handler, and ids of its own', () => {
    const svgs = ['near', 'base', 'solana', 'tempo', 'arbitrum', 'ethereum', 'bitcoin'].map(network => logoSvg('networks', `${network}.svg`)!)
      .concat(['usdc', 'usdt', 'sol', 'near', 'eth', 'btc'].map(token => logoSvg('tokens', `${token}.svg`)!));
    const ids = svgs.flatMap(svg => [...svg.matchAll(/id="([^"]+)"/g)].map(match => match[1]));

    for (const svg of svgs) {
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/);
      expect(svg).not.toMatch(/<(script|style|image|foreignObject|a)\b|\son[a-z]+=|href=|javascript:/i);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves a logo as an SVG, and nothing else', async () => {
    const answer = (kind: string, file: string) => GET(new Request('http://site.test/'), { params: Promise.resolve({ kind, file }) });
    const near = await answer('networks', 'near.svg');

    expect(near.status).toBe(200);
    expect(near.headers.get('content-type')).toBe('image/svg+xml');
    expect(await near.text()).toBe(logoSvg('networks', 'near.svg'));
    for (const [kind, file] of [['networks', 'near'], ['networks', 'nope.svg'], ['tokens', 'constructor.svg'], ['brands', 'near.svg'], ['tokens', 'usdc.png']] as const)
      expect((await answer(kind, file)).status).toBe(404);
  });
});
