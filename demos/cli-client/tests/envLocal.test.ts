import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSavable, createSession, has, saveSecrets } from '../src/envLocal.ts';
import { Stop } from '../src/util.ts';
import { ROOT_NOTE, RUNS_AS_ROOT, tempAppDir } from './helpers.ts';

// Made-up values, not shaped like real keys
const MASTER = 'afm_live_made-up-master';
const PAYMENT = 'af_live_made-up-payment';
const OTHER = 'af_live_made-up-other';

const dirs: { dir: string; remove: () => void }[] = [];
function appDir(): string {
  const made = tempAppDir();
  dirs.push(made);
  return made.dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir.dir, 0o700);
    dir.remove();
  }
});

const read = (dir: string): string => readFileSync(join(dir, '.env.local'), 'utf8');
const mode = (dir: string): number => statSync(join(dir, '.env.local')).mode & 0o777;

describe('saveSecrets', () => {
  it('creates the file with mode 600', () => {
    const dir = appDir();
    saveSecrets(dir, { ANYFARE_MASTER_KEY: MASTER });
    expect(read(dir)).toBe(`# Added by the demo app\nANYFARE_MASTER_KEY=${MASTER}\n`);
    expect(mode(dir)).toBe(0o600);
  });

  it('appends after the existing lines, after a blank line and the comment', () => {
    const dir = appDir();
    writeFileSync(join(dir, '.env.local'), '# My settings\nMAX_PAYMENT_USD=0.05\n');
    saveSecrets(dir, { ANYFARE_MASTER_KEY: MASTER });
    expect(read(dir)).toBe(`# My settings\nMAX_PAYMENT_USD=0.05\n\n# Added by the demo app\nANYFARE_MASTER_KEY=${MASTER}\n`);
  });

  it("replaces an existing variable's line in place, and keeps comments and other lines", () => {
    const dir = appDir();
    writeFileSync(
      join(dir, '.env.local'),
      `# Keys\nANYFARE_MASTER_KEY=${MASTER}\nANYFARE_PAYMENT_KEY=${PAYMENT}\n# The cap\nMAX_PAYMENT_USD=0.05\n`,
    );
    saveSecrets(dir, { ANYFARE_PAYMENT_KEY: OTHER });
    expect(read(dir)).toBe(
      `# Keys\nANYFARE_MASTER_KEY=${MASTER}\nANYFARE_PAYMENT_KEY=${OTHER}\n# The cap\nMAX_PAYMENT_USD=0.05\n`,
    );
  });

  it('replaces an exported line, and appends only the new names', () => {
    const dir = appDir();
    writeFileSync(join(dir, '.env.local'), `export ANYFARE_PAYMENT_KEY=${PAYMENT}`);
    saveSecrets(dir, { ANYFARE_PAYMENT_KEY: OTHER, ANYFARE_MASTER_KEY: MASTER });
    expect(read(dir)).toBe(
      `ANYFARE_PAYMENT_KEY=${OTHER}\n\n# Added by the demo app\nANYFARE_MASTER_KEY=${MASTER}\n`,
    );
  });

  it('sets the mode to 600 on a file that was readable by others', () => {
    const dir = appDir();
    writeFileSync(join(dir, '.env.local'), 'A=1\n');
    chmodSync(join(dir, '.env.local'), 0o644);
    saveSecrets(dir, { ANYFARE_MASTER_KEY: MASTER });
    expect(mode(dir)).toBe(0o600);
  });

  it.each([
    ['a newline', `${PAYMENT}\nEVIL=1`],
    ['a space', 'af_live_two words'],
    ['an equals sign', 'af_live_a=b'],
    ['a quote', 'af_live_"x"'],
    ['nothing', ''],
    ['too many characters', 'a'.repeat(201)],
  ])('refuses a value with %s and writes nothing', (_what, value) => {
    const dir = appDir();
    expect(() => saveSecrets(dir, { ANYFARE_PAYMENT_KEY: value })).toThrow(Stop);
    expect(() => saveSecrets(dir, { ANYFARE_PAYMENT_KEY: value })).toThrow('Refused to save ANYFARE_PAYMENT_KEY');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never puts the value in its message', () => {
    const dir = appDir();
    const value = 'af_live_secret value';
    let message = '';
    try {
      saveSecrets(dir, { ANYFARE_PAYMENT_KEY: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('secret');
  });

  it('takes 200 characters of the allowed set', () => {
    const dir = appDir();
    const value = `Az09_-:.${'x'.repeat(192)}`;
    saveSecrets(dir, { SOME_VALUE: value });
    expect(read(dir)).toContain(`SOME_VALUE=${value}\n`);
  });

  it('refuses a name that is not a variable name', () => {
    const dir = appDir();
    expect(() => saveSecrets(dir, { 'A B': 'x' })).toThrow(Stop);
    expect(() => saveSecrets(dir, { '../x': 'x' })).toThrow(Stop);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes nothing outside the directory and leaves no temporary file', () => {
    const root = appDir();
    const dir = join(root, 'app');
    mkdirSync(dir);
    saveSecrets(dir, { ANYFARE_MASTER_KEY: MASTER });
    saveSecrets(dir, { ANYFARE_PAYMENT_KEY: PAYMENT });
    saveSecrets(dir, { ANYFARE_PAYMENT_KEY: OTHER });
    expect(readdirSync(root)).toEqual(['app']);
    expect(readdirSync(dir)).toEqual(['.env.local']);
  });

  it('stops with a plain line when the directory does not exist', () => {
    const dir = join(appDir(), 'missing');
    expect(() => saveSecrets(dir, { ANYFARE_MASTER_KEY: MASTER })).toThrow('Could not write .env.local: ENOENT');
  });
});

describe('saveSecrets and links, line endings', () => {
  it('refuses a .env.local that is a symbolic link, and leaves the link and its target alone', () => {
    const dir = appDir();
    const target = join(appDir(), 'elsewhere.env');
    writeFileSync(target, 'A=1\n');
    symlinkSync(target, join(dir, '.env.local'));
    expect(() => saveSecrets(dir, { ANYFARE_MASTER_KEY: MASTER })).toThrow(
      '.env.local is a symbolic link, and the app writes keys only into a regular file: replace the link with a file.',
    );
    expect(lstatSync(join(dir, '.env.local')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('A=1\n');
    expect(readdirSync(dir)).toEqual(['.env.local']);
  });

  it('refuses a .env.local that is a directory', () => {
    const dir = appDir();
    mkdirSync(join(dir, '.env.local'));
    expect(() => saveSecrets(dir, { ANYFARE_MASTER_KEY: MASTER })).toThrow('.env.local is not a regular file');
  });

  it('keeps CRLF line endings', () => {
    const dir = appDir();
    writeFileSync(join(dir, '.env.local'), `# Mine\r\nANYFARE_PAYMENT_KEY=${PAYMENT}\r\n`);
    saveSecrets(dir, { ANYFARE_PAYMENT_KEY: OTHER, ANYFARE_MASTER_KEY: MASTER });
    expect(read(dir)).toBe(
      `# Mine\r\nANYFARE_PAYMENT_KEY=${OTHER}\r\n\r\n# Added by the demo app\r\nANYFARE_MASTER_KEY=${MASTER}\r\n`,
    );
  });

  it('returns no warnings when all went well', () => {
    expect(saveSecrets(appDir(), { ANYFARE_MASTER_KEY: MASTER })).toEqual([]);
  });
});

describe('checkSavable', () => {
  it('passes in a writable directory and leaves nothing behind', () => {
    const dir = appDir();
    checkSavable(dir);
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(join(dir, '.env.local'), 'A=1\n', { mode: 0o600 });
    checkSavable(dir);
    expect(readdirSync(dir)).toEqual(['.env.local']);
    expect(read(dir)).toBe('A=1\n');
  });

  it('refuses a directory it can not write in', ({ skip }) => {
    skip(RUNS_AS_ROOT, ROOT_NOTE);
    const dir = appDir();
    chmodSync(dir, 0o500);
    expect(() => checkSavable(dir)).toThrow("The app can't write .env.local in its directory: EACCES.");
  });

  it('refuses a directory that does not exist', () => {
    expect(() => checkSavable(join(appDir(), 'missing'))).toThrow("The app can't write .env.local in its directory: ENOENT.");
  });

  it('refuses a .env.local it can not write', ({ skip }) => {
    skip(RUNS_AS_ROOT, ROOT_NOTE);
    const dir = appDir();
    writeFileSync(join(dir, '.env.local'), 'A=1\n', { mode: 0o400 });
    expect(() => checkSavable(dir)).toThrow(".env.local can't be read and written: EACCES.");
  });

  it('refuses a .env.local that is a symbolic link', () => {
    const dir = appDir();
    symlinkSync(join(appDir(), 'elsewhere.env'), join(dir, '.env.local'));
    expect(() => checkSavable(dir)).toThrow('.env.local is a symbolic link');
  });
});

describe('has', () => {
  it('tells whether .env.local sets a variable to a value', () => {
    const dir = appDir();
    expect(has(dir, 'ANYFARE_MASTER_KEY')).toBe(false);
    writeFileSync(
      join(dir, '.env.local'),
      `# ANYFARE_MASTER_KEY=${MASTER}\nANYFARE_PAYMENT_KEY=\nMAX_PAYMENT_USD=""\n export ANYFARE_SET = ${PAYMENT}\n`,
    );
    expect(has(dir, 'ANYFARE_MASTER_KEY')).toBe(false);
    expect(has(dir, 'ANYFARE_PAYMENT_KEY')).toBe(false);
    expect(has(dir, 'MAX_PAYMENT_USD')).toBe(false);
    expect(has(dir, 'ANYFARE_SET')).toBe(true);
    expect(has(dir, 'ANYFARE')).toBe(false);
  });
});

describe('createSession', () => {
  it('starts from the environment and uses saved values from then on, without changing the environment', () => {
    const dir = appDir();
    const env = { ANYFARE_API_URL: 'http://127.0.0.1:1' };
    const before = process.env['ANYFARE_MASTER_KEY'];
    const session = createSession(env, dir);
    expect(session.isSet('ANYFARE_MASTER_KEY')).toBe(false);
    session.save({ ANYFARE_MASTER_KEY: MASTER });
    expect(session.env['ANYFARE_MASTER_KEY']).toBe(MASTER);
    expect(session.env['ANYFARE_API_URL']).toBe('http://127.0.0.1:1');
    expect(session.isSet('ANYFARE_MASTER_KEY')).toBe(true);
    expect(env).toEqual({ ANYFARE_API_URL: 'http://127.0.0.1:1' });
    expect(process.env['ANYFARE_MASTER_KEY']).toBe(before);
  });

  it('counts a variable that only .env.local sets', () => {
    const dir = appDir();
    writeFileSync(join(dir, '.env.local'), `ANYFARE_MASTER_KEY=${MASTER}\n`);
    expect(createSession({}, dir).isSet('ANYFARE_MASTER_KEY')).toBe(true);
  });
});
