import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { createLogger, Secret } from '@anyfare/common';
import { migrateDatabase } from '@anyfare/db';

import { assertLocalDatabase } from './guard.js';

// A scratch database: a new, empty one next to the local database, on the same server with the same role,
// for a run that needs a zero state. Nothing in the local database is read or changed. A tool drops only the
// scratch database it created, by its exact name.

export const scratchPrefix = 'anyfare_scratch_';
export const scratchPattern = /^anyfare_scratch_[0-9a-z]+_[0-9a-f]{12}$/;

export interface ScratchDatabase {
  readonly name: string;
  // Its URL, with the local database's server and role
  readonly url: Secret;
  /** Drops this database, by its name. Safe to call twice. */
  drop(): Promise<void>;
}

const quote = pg.escapeIdentifier;

const serverClient = async (databaseUrl: string): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  return client;
};

/** The URL of the database `name` on the server of `databaseUrl`. */
export const urlOfDatabase = (databaseUrl: string, name: string): Secret => {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;

  return Secret.from(url.href);
};

/** Whether `name` is one a scratch run makes. Anything else is never dropped. */
export const isScratchName = (name: string): boolean => scratchPattern.test(name);

const dropByName = async (databaseUrl: string, name: string): Promise<void> => {
  if (!isScratchName(name))
    throw new Error(`${name} is not the name of a scratch database`);
  const client = await serverClient(databaseUrl);
  try {
    await client.query(`drop database if exists ${quote(name)} with (force)`);
  }
  finally {
    await client.end();
  }
};

/** Creates a new empty database with a fresh name, and runs the migrations in it. The local-only guard applies. */
export const createScratchDatabase = async (databaseUrl: string): Promise<ScratchDatabase> => {
  assertLocalDatabase(databaseUrl);
  const name = `${scratchPrefix}${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
  const client = await serverClient(databaseUrl);
  try {
    await client.query(`create database ${quote(name)}`);
  }
  finally {
    await client.end();
  }
  const url = urlOfDatabase(databaseUrl, name);
  let dropped: Promise<void> | undefined;
  const drop = (): Promise<void> => dropped ??= dropByName(databaseUrl, name);
  try {
    await migrateDatabase({ url, logger: createLogger({ level: 'silent' }) });
  }
  catch (error) {
    await drop().catch(() => undefined);
    throw error;
  }

  return { name, url, drop };
};

/** Drops the scratch database `name` a tool created before. Refuses any other name. */
export const dropScratchDatabase = async (databaseUrl: string, name: string): Promise<void> => {
  assertLocalDatabase(databaseUrl);
  await dropByName(databaseUrl, name);
};
