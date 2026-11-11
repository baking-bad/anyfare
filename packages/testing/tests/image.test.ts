import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Build metadata carried by the image and CI.

const repoFile = (path: string): Promise<string> => readFile(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

describe('the image\'s commit', () => {
  it('the Dockerfile sets GIT_SHA from a build argument', async () => {
    expect(await repoFile('Dockerfile')).toMatch(/ARG GIT_SHA=""\nENV GIT_SHA=\$\{GIT_SHA\}/);
  });

  it('the website\'s Dockerfile sets GIT_SHA from a build argument', async () => {
    expect(await repoFile('packages/web/Dockerfile')).toMatch(/ARG GIT_SHA=""\nENV GIT_SHA=\$\{GIT_SHA\}/);
  });

  // One build for the backend image, one for the website's
  it('CI passes the commit to both image builds', async () => {
    const ci = await repoFile('.github/workflows/ci.yml');

    expect(ci.match(/build-args: \|\n\s+GIT_SHA=\$\{\{ github\.sha \}\}/g)).toHaveLength(2);
  });
});
