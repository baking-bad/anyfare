// Saves the Anyfare keys into the app's .env.local, the file `npm run demo` reads them from.

import { randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stop } from './util.ts';

/** The directory of the app's package.json: the one `npm run demo` runs in. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

export const ENV_LOCAL = '.env.local';

const ADDED_COMMENT = '# Added by the demo app';
const NAME = /^[A-Z_][A-Z0-9_]*$/;
const VALUE = /^[A-Za-z0-9_\-:.]+$/;
const MAX_VALUE_LENGTH = 200;
// What a directory `fsync` fails with where it is not supported
const DIRECTORY_SYNC_UNSUPPORTED: ReadonlySet<string> = new Set(['EISDIR', 'EPERM', 'EINVAL']);

function fileOf(dir: string): string {
  return join(dir, ENV_LOCAL);
}

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? 'unknown error';

function temporaryOf(dir: string): string {
  return join(dir, `${ENV_LOCAL}.${randomBytes(6).toString('hex')}.tmp`);
}

/**
 * Whether `.env.local` exists. A symbolic link or anything else that is not a regular file is refused:
 * the app writes only a regular file of its own directory.
 */
function existing(path: string): boolean {
  let isLink: boolean;
  let isFile: boolean;
  try {
    const stats = lstatSync(path);
    isLink = stats.isSymbolicLink();
    isFile = stats.isFile();
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw new Stop(`Could not read ${ENV_LOCAL}: ${codeOf(error)}.`);
  }
  if (isLink) {
    throw new Stop(`${ENV_LOCAL} is a symbolic link, and the app writes keys only into a regular file: replace the link with a file.`);
  }
  if (!isFile) throw new Stop(`${ENV_LOCAL} is not a regular file, so the app can't write keys into it.`);
  return true;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw new Stop(`Could not read ${ENV_LOCAL}: ${codeOf(error)}.`);
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The descriptor is gone either way
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing more can be done about it
  }
}

/** Writes the whole text to a new file with mode 600, through a descriptor, and syncs it to disk. */
function writeNew(path: string, text: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    const bytes = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
  closeSync(fd);
}

/**
 * Proves that `saveSecrets` can save into `dir`, before a request whose answer holds a key shown only
 * once: `.env.local`, when it exists, is a regular file that can be read and written, and a new file
 * can be made, written, synced and removed next to it.
 */
export function checkSavable(dir: string): void {
  const path = fileOf(dir);
  if (existing(path)) {
    try {
      accessSync(path, constants.R_OK | constants.W_OK);
      readFileSync(path);
    } catch (error) {
      throw new Stop(`${ENV_LOCAL} can't be read and written: ${codeOf(error)}.`);
    }
  }
  const probe = temporaryOf(dir);
  try {
    writeNew(probe, '\n');
    rmSync(probe);
  } catch (error) {
    removeQuietly(probe);
    throw new Stop(`The app can't write ${ENV_LOCAL} in its directory: ${codeOf(error)}.`);
  }
}

/** The line sets this variable: `NAME=…`, or `export NAME=…`. */
function setsName(line: string, name: string): boolean {
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);
}

/** The value a line sets, without quotes. */
function valueOf(line: string): string {
  const value = line.slice(line.indexOf('=') + 1).trim();
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1).trim() : value;
}

/** Checks a name and its value. The message names the variable, never the value. */
function check(name: string, value: string): void {
  if (!NAME.test(name)) throw new Stop(`Refused to save ${JSON.stringify(name)}: not a variable name`);
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH || !VALUE.test(value)) {
    throw new Stop(
      `Refused to save ${name}: a value may have only A-Z, a-z, 0-9, "_", "-", ":" and ".", at most ${MAX_VALUE_LENGTH} characters`,
    );
  }
}

/**
 * Sets each variable in `<dir>/.env.local`: the line of a variable that is there already is replaced,
 * the others are appended under a comment, in the file's own line endings. The file is written whole
 * to a temporary file next to it, synced, renamed over it, and kept at mode 600. Values are never
 * printed. Returns warnings about a file that was saved but not quite as it should be.
 */
export function saveSecrets(dir: string, values: Readonly<Record<string, string>>): readonly string[] {
  const entries = Object.entries(values);
  for (const [name, value] of entries) check(name, value);
  if (entries.length === 0) return [];

  const path = fileOf(dir);
  const old = existing(path) ? readText(path) : undefined;
  const eol = old?.includes('\r\n') === true ? '\r\n' : '\n';
  const lines = old === undefined || old === '' ? [] : old.replace(/\r?\n$/, '').split(/\r?\n/);
  const added: string[] = [];
  for (const [name, value] of entries) {
    let found = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (setsName(lines[index] ?? '', name)) {
        lines[index] = `${name}=${value}`;
        found = true;
      }
    }
    if (!found) added.push(`${name}=${value}`);
  }
  if (added.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(ADDED_COMMENT, ...added);
  }

  const temporary = temporaryOf(dir);
  try {
    writeNew(temporary, `${lines.join(eol)}${eol}`);
    renameSync(temporary, path);
  } catch (error) {
    removeQuietly(temporary);
    throw new Stop(`Could not write ${ENV_LOCAL}: ${codeOf(error)}`);
  }

  // Saved from here on: a failure is a warning, never "not saved"
  const warnings: string[] = [];
  // Windows can't sync a directory; elsewhere these codes mean the file system doesn't support it
  if (process.platform !== 'win32') {
    try {
      const fd = openSync(dir, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeQuietly(fd);
      }
    } catch (error) {
      if (!DIRECTORY_SYNC_UNSUPPORTED.has(codeOf(error))) {
        warnings.push(`Saved to ${ENV_LOCAL}, but its directory could not be synced to disk: ${codeOf(error)}.`);
      }
    }
  }
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    warnings.push(`Saved to ${ENV_LOCAL}, but its mode could not be set to 600 (${codeOf(error)}): run chmod 600 ${ENV_LOCAL}.`);
  }
  return warnings;
}

/** Whether `<dir>/.env.local` sets this variable to a value that is not empty. */
export function has(dir: string, name: string): boolean {
  if (!NAME.test(name)) return false;
  const text = readText(fileOf(dir));
  if (text === undefined) return false;
  return text.split(/\r?\n/).some((line) => setsName(line, name) && valueOf(line) !== '');
}

/** The settings of one run: they start from the environment and change when keys are saved. */
export interface Session {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether the environment or `.env.local` sets this variable. */
  isSet(name: string): boolean;
  /** A `Stop` unless `save` can write `.env.local`: for before a request whose key is shown once. */
  checkSavable(): void;
  /** Saves into `.env.local`, then uses the new values for the rest of the run. Returns warnings. */
  save(values: Readonly<Record<string, string>>): readonly string[];
}

export function createSession(env: Readonly<Record<string, string | undefined>>, dir: string): Session {
  let current: Readonly<Record<string, string | undefined>> = { ...env };
  return {
    get env() {
      return current;
    },
    isSet(name) {
      return (current[name]?.trim() ?? '') !== '' || has(dir, name);
    },
    checkSavable() {
      checkSavable(dir);
    },
    save(values) {
      const warnings = saveSecrets(dir, values);
      current = { ...current, ...values };
      return warnings;
    },
  };
}
