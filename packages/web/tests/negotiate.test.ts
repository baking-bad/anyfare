import { describe, expect, it } from 'vitest';

import { changeOf, formatChange } from '../src/home/change';
import { hasMarkdown, markdownRoute, markdownUrl, pageForMarkdownUrl, prefersMarkdown } from '../src/markdown/negotiate';

describe('the Markdown twins of the pages', () => {
  it('maps the twin\'s URL to its page and back', () => {
    expect(pageForMarkdownUrl('/index.md')).toBe('/');
    expect(markdownUrl('/')).toBe('/index.md');
    expect(hasMarkdown('/')).toBe(true);
    expect(markdownRoute('/')).toBe('/md');
    expect(markdownRoute('/services')).toBe('/md/services');
  });

  it.each(['/.md', '/llms.txt', '/nothing.md', '/dev/components.md'])('has no twin for %s', url => {
    expect(pageForMarkdownUrl(url)).toBeUndefined();
  });

  it.each([
    ['text/markdown', true],
    ['text/markdown, text/html;q=0.5', true],
    ['text/html, text/markdown;q=0.9', false],
    ['text/html,application/xhtml+xml,*/*;q=0.8', false],
    ['*/*', false],
    ['text/markdown;q=0', false],
    [null, false],
  ])('reads Accept: %s as Markdown: %s', (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });
});

describe('the change pill', () => {
  it('compares this period with the one before, and has nothing to say without one', () => {
    expect(formatChange(changeOf('18.42', '16.39')!)).toBe('+12.4%');
    expect(formatChange(changeOf('8', '10')!)).toBe('-20.0%');
    expect(changeOf('5', '0')).toBeNull();
    expect(changeOf('0', '0')).toBeNull();
    expect(changeOf('x', '1')).toBeNull();
  });
});
