// The order of the file system calls of a save, and a chmod that fails after the rename.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardingFetch, startFakeAnyfare, toolRoutes } from './fakeAnyfare.ts';
import type { FakeAnyfare } from './fakeAnyfare.ts';
import { captureIo, tempAppDir } from './helpers.ts';

const spy = vi.hoisted(() => ({ calls: [] as string[], failChmod: false, failDirSync: undefined as string | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fds = new Map<number, string>();
  const name = (path: unknown): string => {
    const text = String(path);
    if (text.endsWith('.tmp')) return 'tmp';
    if (text.endsWith('.env.local')) return '.env.local';
    return 'dir';
  };
  return {
    ...actual,
    openSync: (path: string, flags: string, mode?: number) => {
      const fd = actual.openSync(path, flags, mode);
      fds.set(fd, name(path));
      spy.calls.push(`open ${name(path)} ${flags}${mode === undefined ? '' : ` ${mode.toString(8)}`}`);
      return fd;
    },
    writeSync: (fd: number, ...rest: [Buffer, number, number]) => {
      spy.calls.push(`write ${fds.get(fd)}`);
      return actual.writeSync(fd, ...rest);
    },
    fsyncSync: (fd: number) => {
      spy.calls.push(`fsync ${fds.get(fd)}`);
      if (fds.get(fd) === 'dir' && spy.failDirSync !== undefined) {
        throw Object.assign(new Error('Made-up failure'), { code: spy.failDirSync });
      }
      actual.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      spy.calls.push(`close ${fds.get(fd)}`);
      actual.closeSync(fd);
    },
    renameSync: (from: string, to: string) => {
      spy.calls.push(`rename ${name(from)} ${name(to)}`);
      actual.renameSync(from, to);
    },
    chmodSync: (path: string, mode: number) => {
      spy.calls.push(`chmod ${name(path)} ${mode.toString(8)}`);
      if (spy.failChmod) throw Object.assign(new Error('Made-up failure'), { code: 'EPERM' });
      actual.chmodSync(path, mode);
    },
  };
});

const { saveSecrets, createSession } = await import('../src/envLocal.ts');
const { runCli } = await import('../src/cli.ts');

let fake: FakeAnyfare;
beforeAll(async () => {
  fake = await startFakeAnyfare();
});
afterAll(async () => {
  await fake.close();
});

let app: { dir: string; remove: () => void };
beforeEach(() => {
  app = tempAppDir();
  spy.calls.length = 0;
  spy.failChmod = false;
  spy.failDirSync = undefined;
});
afterEach(() => {
  app.remove();
});

describe('saveSecrets on disk', () => {
  it('writes through a descriptor, syncs it, renames it, then syncs the directory and sets the mode', () => {
    saveSecrets(app.dir, { ANYFARE_MASTER_KEY: 'afm_live_made-up' });
    expect(spy.calls).toEqual([
      'open tmp wx 600',
      'write tmp',
      'fsync tmp',
      'close tmp',
      'rename tmp .env.local',
      'open dir r',
      'fsync dir',
      'close dir',
      'chmod .env.local 600',
    ]);
  });

  it('warns, and keeps the saved key, when the mode can not be set after the rename', () => {
    spy.failChmod = true;
    const session = createSession({}, app.dir);
    const warnings = session.save({ ANYFARE_MASTER_KEY: 'afm_live_made-up' });
    expect(warnings).toEqual(['Saved to .env.local, but its mode could not be set to 600 (EPERM): run chmod 600 .env.local.']);
    expect(readFileSync(join(app.dir, '.env.local'), 'utf8')).toContain('ANYFARE_MASTER_KEY=afm_live_made-up');
    expect(session.env['ANYFARE_MASTER_KEY']).toBe('afm_live_made-up');
  });

  it.each(['EISDIR', 'EPERM', 'EINVAL'])('takes %s from the directory sync as "not supported", with no warning', (code) => {
    spy.failDirSync = code;
    expect(saveSecrets(app.dir, { ANYFARE_MASTER_KEY: 'afm_live_made-up' })).toEqual([]);
    expect(spy.calls).toContain('fsync dir');
    expect(readFileSync(join(app.dir, '.env.local'), 'utf8')).toContain('ANYFARE_MASTER_KEY=afm_live_made-up');
  });

  it('warns about any other failure of the directory sync, and keeps the saved key', () => {
    spy.failDirSync = 'EIO';
    expect(saveSecrets(app.dir, { ANYFARE_MASTER_KEY: 'afm_live_made-up' })).toEqual([
      'Saved to .env.local, but its directory could not be synced to disk: EIO.',
    ]);
    expect(readFileSync(join(app.dir, '.env.local'), 'utf8')).toContain('ANYFARE_MASTER_KEY=afm_live_made-up');
  });

  it('does not sync the directory on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (platform === undefined) throw new Error('Expected process.platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      spy.failDirSync = 'EIO';
      expect(saveSecrets(app.dir, { ANYFARE_MASTER_KEY: 'afm_live_made-up' })).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(spy.calls).not.toContain('open dir r');
    expect(spy.calls).not.toContain('fsync dir');
    expect(spy.calls.at(-1)).toBe('chmod .env.local 600');
  });

  it('ends key create with exit 0 and a warning when only the mode could not be set', async () => {
    spy.failChmod = true;
    const account = fake.addAccount();
    const { fetch } = forwardingFetch(toolRoutes());
    const io = captureIo(
      fetch,
      { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ANYFARE_MASTER_KEY: account.masterKey },
      { appDir: app.dir },
    );
    expect(await runCli(['key', 'create', '--yes'], io.io)).toBe(0);
    expect(io.err()).toBe('Saved to .env.local, but its mode could not be set to 600 (EPERM): run chmod 600 .env.local.\n');
    expect(io.out()).toContain('Payment key created');
    expect(readFileSync(join(app.dir, '.env.local'), 'utf8')).toMatch(/^ANYFARE_PAYMENT_KEY=af_live_/m);
  });
});
