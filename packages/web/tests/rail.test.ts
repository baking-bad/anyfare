import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Rail, RailIcon, railToken } from '../src/components/Rail';

const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

describe('the icon of a way of paying', () => {
  it('is the network letter alone without a token', () => {
    expect(html(createElement(RailIcon, { rail: 'base' }))).toBe('<span class="coin s16" aria-hidden="true"><i>B</i></span>');
  });

  it('is the token letter with the network letter at its corner', () => {
    expect(html(createElement(RailIcon, { rail: 'near', token: 'USDC', size: 32 }))).toBe('<span class="coin pair s32 near" aria-hidden="true"><i>U</i><i class="net">N</i></span>');
  });

  it('takes the first letter or digit of a token and of an unknown network', () => {
    expect(html(createElement(RailIcon, { rail: 'ethereum', token: 'wETH' }))).toContain('<i>W</i><i class="net">E</i>');
    expect(html(createElement(RailIcon, { rail: 'base', token: '.e' }))).toContain('<i>E</i>');
  });

  it('is one circle for Credits, even with a token', () => {
    expect(html(createElement(RailIcon, { rail: 'credits', token: 'Credits', size: 24 }))).toBe('<span class="coin s24" aria-hidden="true"><i>$</i></span>');
  });

  it('marks a chip with a pair, and keeps its label', () => {
    expect(html(createElement(Rail, { rail: 'solana', token: 'SOL', label: 'SOL on Solana' }))).toBe('<span class="rail pair"><span class="coin pair s16" aria-hidden="true"><i>S</i><i class="net">S</i></span>SOL on Solana</span>');
    expect(html(createElement(Rail, { rail: 'near' }))).toBe('<span class="rail near"><span class="coin s16 near" aria-hidden="true"><i>N</i></span>NEAR</span>');
  });
});

describe('the token of a way of paying', () => {
  it('is USDC on the x402 chains and USDC.e on Tempo, none for Credits or an unknown network', () => {
    expect(['near', 'base', 'solana', 'tempo', 'credits', 'bitcoin'].map(railToken)).toEqual(['USDC', 'USDC', 'USDC', 'USDC.e', undefined, undefined]);
  });
});
