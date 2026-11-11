import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import PageError from '../app/error';
import { asksMissingMarkdown, isKnownPath, missingMarkdown } from '../src/missing/routes';

const appRoot = fileURLToPath(new URL('../app', import.meta.url));

// Every route of `app/` as the path it answers, with a dynamic segment as `x`
const routesOf = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  if (statSync(path).isDirectory())
    return routesOf(path);
  const own = relative(appRoot, directory).split('/').filter(Boolean).map(part => decodeURIComponent(part).replace(/^\[\[?\.{0,3}[a-z]+\]?\]$/i, 'x'));
  if (/^(page|route)\.tsx?$/.test(name))
    return [`/${own.join('/')}`];
  if (/^(icon|apple-icon|opengraph-image)\.tsx$/.test(name))
    return [`/${[...own, name.replace(/\.tsx$/, '')].join('/')}`];
  if (name === 'robots.ts' || name === 'sitemap.ts')
    return [`/${name.replace(/\.ts$/, name === 'robots.ts' ? '.txt' : '.xml')}`];

  return [];
});

describe('the paths the site serves', () => {
  it('know every route of app/, so a new route is added to the list or this test fails', () => {
    const unknown = routesOf(appRoot).filter(path => !isKnownPath(path));

    expect(unknown).toEqual([]);
  });

  it('know the proxy\'s own rewrite targets and the framework\'s files', () => {
    for (const path of ['/md/calls', '/md', '/_/missing/receipt', '/_/listing', '/_/console', '/_/hidden', '/_next/static/x.js', '/skills/anyfare-buyer/SKILL.md'])
      expect(isKnownPath(path), path).toBe(true);
  });
});

describe('a missing path asked as Markdown', () => {
  it('is a miss for a `.md` address that is no page, and for any unknown path that prefers Markdown', () => {
    expect(asksMissingMarkdown('/nothing.md', false)).toBe(true);
    expect(asksMissingMarkdown('/nothing', true)).toBe(true);
    expect(asksMissingMarkdown('/nothing', false)).toBe(false);
    expect(asksMissingMarkdown('/a/b/c', true)).toBe(true);
  });

  it('is not a miss for a page, a file, or the skill', () => {
    expect(asksMissingMarkdown('/calls', true)).toBe(false);
    expect(asksMissingMarkdown('/llms.txt', true)).toBe(false);
    expect(asksMissingMarkdown('/skills/anyfare-buyer/SKILL.md', false)).toBe(false);
    expect(asksMissingMarkdown('/services/api.example.com', true)).toBe(false);
  });

  it('answers "# Not found", one line, and links to /index.md and /llms.txt', () => {
    const body = missingMarkdown('https://site.example.com');
    const lines = body.trim().split('\n').filter(line => line !== '');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('# Not found');
    expect(body).toContain('(https://site.example.com/index.md)');
    expect(body).toContain('(https://site.example.com/llms.txt)');
  });
});

describe('the error page', () => {
  const html = renderToStaticMarkup(createElement(PageError, { error: new Error('x'), reset: () => {} }));

  it('has its own title and no search engine keeps it', () => {
    expect(html).toContain('<title>This page didn&#x27;t load | Anyfare</title>');
    expect(html).toContain('<meta name="robots" content="noindex"/>');
  });

  it('says it didn\'t load, offers a way home and a retry, and hides the Human / Agent switch', () => {
    expect(html).toContain('This page didn&#x27;t load</h1>');
    expect(html).toContain('href="/"');
    expect(html).toContain('Try again');
    expect(html).toContain('no-agent-view');
  });

  it('leaks nothing of the error', () => {
    const leaking = renderToStaticMarkup(createElement(PageError, { error: new Error('secret detail'), reset: () => {} }));

    expect(leaking).not.toContain('secret detail');
  });
});
