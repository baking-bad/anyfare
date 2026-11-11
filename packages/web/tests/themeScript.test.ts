import { describe, expect, it } from 'vitest';

import { themeScript } from '../src/theme-script';

// The inline script in <head> runs before the first paint. It is plain ES5 text, so the test runs it against a
// small fake `document`, `localStorage` and `matchMedia`.

interface Page {
  readonly classes: Set<string>;
  readonly attributes: Map<string, string>;
}

const run = (saved: Readonly<Record<string, string>> | 'throws', systemDark: boolean): Page => {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const root = {
    classList: { add: (name: string) => classes.add(name), remove: (...names: string[]) => names.forEach(name => classes.delete(name)) },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const storage = {
    getItem: (key: string): string | null => {
      if (saved === 'throws')
        throw new Error('Storage is blocked');

      return saved[key] ?? null;
    },
  };
  const matchMedia = (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark });
  new Function('document', 'localStorage', 'matchMedia', themeScript)({ documentElement: root }, storage, matchMedia);

  return { classes, attributes };
};

describe('the theme script', () => {
  it('sets the class of the saved choice, whatever the system says', () => {
    expect([...run({ 'anyfare-theme': 'dark' }, false).classes]).toEqual(['dark']);
    expect([...run({ 'anyfare-theme': 'light' }, true).classes]).toEqual(['light']);
  });

  it('follows the system when nothing is saved, or the saved value is not a choice', () => {
    expect([...run({}, true).classes]).toEqual(['dark']);
    expect([...run({}, false).classes]).toEqual(['light']);
    expect([...run({ 'anyfare-theme': 'system' }, true).classes]).toEqual(['dark']);
  });

  it('follows the system when storage throws, and still sets a class', () => {
    expect([...run('throws', true).classes]).toEqual(['dark']);
    expect([...run('throws', false).classes]).toEqual(['light']);
    expect(run('throws', false).attributes.size).toBe(0);
  });

  it('marks the Agent view only when the visitor chose it', () => {
    expect(run({ 'anyfare-view': 'agent' }, false).attributes.get('data-view')).toBe('agent');
    expect(run({ 'anyfare-view': 'human' }, false).attributes.has('data-view')).toBe(false);
    expect(run({}, false).attributes.has('data-view')).toBe(false);
  });

  it('is plain text with no reference to the network or the page\'s own scripts', () => {
    expect(themeScript).not.toMatch(/fetch|XMLHttpRequest|import\(/);
  });
});
