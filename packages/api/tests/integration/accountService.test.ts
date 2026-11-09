import { fixtureTime } from '@anyfare/testing';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cryptoRandomSource, hashApiKey, InvalidKeyError, type AuditLog } from '@anyfare/core';
import { accounts, apiKeys, auditLog, createAuditLogRepository, createLedger, ledgerAccountIds, ledgerTransactions } from '@anyfare/db';
import { createFakeClock, createFakeIdGenerator, createTestDatabase, type TestDatabase } from '@anyfare/testing';

import { createAccountService, type AccountServiceOptions } from '../../src/accounts/service.js';

const keyPrefixes = { master: 'afm_test_', payment: 'af_test_' };

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

const buildService = (options: Partial<AccountServiceOptions> = {}) => {
  const clock = createFakeClock(fixtureTime(0, 9, 12, 0, 0, 0));
  const ids = createFakeIdGenerator(`${Math.random().toString(36).slice(2, 8)}-`);

  return {
    clock,
    ids,
    service: createAccountService({ db: database.db, clock, ids, random: cryptoRandomSource, keyPrefixes, ...options }),
  };
};

// Writes the entry, then fails, as if a later step of the transaction had failed
const failingAfterAppend = (options: Pick<AccountServiceOptions, 'clock' | 'ids'>): AccountServiceOptions['auditLog'] => tx => {
  const real: AuditLog = createAuditLogRepository({ db: tx, ...options });

  return {
    append: async entry => {
      await real.append(entry);
      throw new Error('a later step failed');
    },
  };
};

const auditRowsFor = (accountId: string) => database.db.select().from(auditLog).where(eq(auditLog.subjectId, accountId));
const keyRowsFor = (accountId: string) => database.db.select().from(apiKeys).where(eq(apiKeys.accountId, accountId));

describe('creating an account', () => {
  it('stores the account, its master key hash, and one audit entry with the request ID and no key', async () => {
    const { service, clock } = buildService();

    const { account, masterKey, freeCredits } = await service.create({ requestId: 'req-create' });

    expect(account).toEqual({ id: expect.stringMatching(/^acc_/), createdAt: clock.now() });
    expect(freeCredits).toBe(0n);
    expect(account.id).toMatch(/^acc_/);
    const keys = await keyRowsFor(account.id);
    expect(keys).toEqual([expect.objectContaining({ kind: 'master', keyHash: hashApiKey(masterKey), revokedAt: null })]);
    expect(keys[0]!.id).toMatch(/^key_/);
    const entries = await auditRowsFor(account.id);
    expect(entries).toEqual([expect.objectContaining({
      actorKind: 'account',
      actorId: account.id,
      action: 'account.create',
      subjectKind: 'account',
      requestId: 'req-create',
      details: { masterKeyId: keys[0]!.id, freeCredits: '0' },
    })]);
    expect(JSON.stringify(entries)).not.toContain(masterKey.expose());
    expect(JSON.stringify(entries)).not.toContain(hashApiKey(masterKey));
  });

  it('writes neither the account, the key, nor the entry when the transaction fails after all three', async () => {
    const clock = createFakeClock();
    const ids = createFakeIdGenerator('failed-create-');
    const { service: failing } = buildService({ clock, ids, auditLog: failingAfterAppend({ clock, ids }) });

    await expect(failing.create({ requestId: 'req-failed' })).rejects.toThrow('a later step failed');

    const accountId = 'acc_failed-create-1';
    expect(ids.issued.slice(0, 2)).toEqual(['failed-create-1', 'failed-create-2']);
    expect(await database.db.select().from(accounts).where(eq(accounts.id, accountId))).toEqual([]);
    expect(await keyRowsFor(accountId)).toEqual([]);
    expect(await auditRowsFor(accountId)).toEqual([]);
  });
});

describe('free credits', () => {
  const transactionsFor = (accountId: string) => database.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.reference, accountId));

  it('books the gift with the account, keyed by its ID, and records it in the audit entry', async () => {
    const { service, clock, ids } = buildService();

    const { account, freeCredits } = await service.create({ requestId: 'req-gift', freeCredits: 100_000n });

    expect(freeCredits).toBe(100_000n);
    expect(await createLedger({ db: database.db, clock, ids }).balance(account.id)).toEqual({ available: 100_000n, held: 0n });
    expect(await transactionsFor(account.id)).toEqual([expect.objectContaining({ operation: 'promotion', requestId: 'req-gift' })]);
    expect((await auditRowsFor(account.id))[0]?.details).toMatchObject({ freeCredits: '0.1' });
  });

  it('books nothing for no gift', async () => {
    const { service, clock, ids } = buildService();

    const { account } = await service.create({ requestId: 'req-no-gift', freeCredits: 0n });

    expect(await transactionsFor(account.id)).toEqual([]);
    const ledger = createLedger({ db: database.db, clock, ids });
    expect(await ledger.balancesOf([ledgerAccountIds.available(account.id)])).toEqual(new Map());
  });

  it('creates no account when its gift can\'t be booked: the account and its gift commit together', async () => {
    const clock = createFakeClock();
    const ids = createFakeIdGenerator('failed-gift-');
    const { service } = buildService({ clock, ids });

    // Past a bigint balance, so the gift's own posting fails, after the account and its key were written
    await expect(service.create({ requestId: 'req-failed-gift', freeCredits: 2n ** 63n })).rejects.toThrow();

    const accountId = 'acc_failed-gift-1';
    expect(await database.db.select().from(accounts).where(eq(accounts.id, accountId))).toEqual([]);
    expect(await keyRowsFor(accountId)).toEqual([]);
    expect(await auditRowsFor(accountId)).toEqual([]);
    expect(await transactionsFor(accountId)).toEqual([]);
  });
});

describe('rotating the master key', () => {
  it('revokes the key used, stores the new key hash, and writes one audit entry with the request ID and no key', async () => {
    const { service } = buildService();
    const { account, masterKey: oldKey } = await service.create({ requestId: 'req-signup' });
    const [oldRow] = await keyRowsFor(account.id);

    const newKey = await service.rotateMasterKey({ accountId: account.id, keyId: oldRow!.id, requestId: 'req-rotate' });

    expect(newKey.expose()).toMatch(/^afm_test_[0-9A-Za-z]{43}$/);
    const keys = await keyRowsFor(account.id);
    const active = keys.filter(key => key.revokedAt === null);
    expect(active).toEqual([expect.objectContaining({ kind: 'master', keyHash: hashApiKey(newKey) })]);
    expect(keys.find(key => key.id === oldRow!.id)?.revokedAt).toBeInstanceOf(Date);
    const rotations = (await auditRowsFor(account.id)).filter(entry => entry.action === 'master_key.rotate');
    expect(rotations).toEqual([expect.objectContaining({
      actorId: account.id,
      requestId: 'req-rotate',
      details: { revokedKeyId: oldRow!.id, masterKeyId: active[0]!.id },
    })]);
    for (const secret of [oldKey.expose(), newKey.expose(), hashApiKey(newKey)])
      expect(JSON.stringify(rotations)).not.toContain(secret);
  });

  it('keeps the old key and writes nothing when the transaction fails after the change and the entry', async () => {
    const clock = createFakeClock();
    const ids = createFakeIdGenerator('failed-rotate-');
    const { service: working } = buildService({ clock, ids });
    const { account, masterKey } = await working.create({ requestId: 'req-signup' });
    const [oldRow] = await keyRowsFor(account.id);
    const { service: failing } = buildService({ clock, ids, auditLog: failingAfterAppend({ clock, ids }) });

    await expect(failing.rotateMasterKey({ accountId: account.id, keyId: oldRow!.id, requestId: 'req-failed' }))
      .rejects.toThrow('a later step failed');

    expect(await keyRowsFor(account.id)).toEqual([expect.objectContaining({ id: oldRow!.id, keyHash: hashApiKey(masterKey), revokedAt: null })]);
    expect((await auditRowsFor(account.id)).map(entry => entry.action)).toEqual(['account.create']);
  });

  it('refuses to rotate with a key that is already revoked, such as by a concurrent rotation', async () => {
    const { service } = buildService();
    const { account } = await service.create({ requestId: 'req-signup' });
    const [oldRow] = await keyRowsFor(account.id);
    await service.rotateMasterKey({ accountId: account.id, keyId: oldRow!.id, requestId: 'req-first' });

    await expect(service.rotateMasterKey({ accountId: account.id, keyId: oldRow!.id, requestId: 'req-second' }))
      .rejects.toThrow(InvalidKeyError);

    expect((await keyRowsFor(account.id)).filter(key => key.revokedAt === null)).toHaveLength(1);
  });
});

describe('key storage', () => {
  it('stores only the hash: no column of any table holds the key or its body', async () => {
    const { service } = buildService();
    const { account, masterKey } = await service.create({ requestId: 'req-stored' });
    const [row] = await keyRowsFor(account.id);
    const rotated = await service.rotateMasterKey({ accountId: account.id, keyId: row!.id, requestId: 'req-stored-rotate' });
    const { rows: tables } = await database.db.execute<{ name: string }>(
      sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );

    expect(tables.map(table => table.name)).toEqual(expect.arrayContaining(['accounts', 'api_keys', 'audit_log']));
    for (const { name } of tables) {
      const { rows } = await database.db.execute<{ row: string }>(sql`select row_to_json(t)::text as row from ${sql.identifier(name)} t`);
      const contents = rows.map(({ row }) => row).join('\n');
      for (const key of [masterKey.expose(), rotated.expose()]) {
        expect(contents).not.toContain(key);
        expect(contents).not.toContain(key.slice(keyPrefixes.master.length));
      }
    }
    expect(row!.keyHash).toBe(hashApiKey(masterKey));
  });
});
