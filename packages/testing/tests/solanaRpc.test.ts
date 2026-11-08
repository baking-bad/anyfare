import {
  address, appendTransactionMessageInstructions, createTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, AccountRole,
  type Blockhash,
} from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  associatedTokenAddress, decodeSolanaPayment, encodeBase58, startFakeSolanaRpc, tokenProgramAddress, type FakeSolanaRpc,
} from '../src/index.js';

const owner = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const mint = encodeBase58(Uint8Array.from({ length: 32 }, () => 9));

let rpc: FakeSolanaRpc;

beforeEach(async () => {
  rpc = await startFakeSolanaRpc();
});

afterEach(async () => {
  await rpc.close();
});

const send = async (method: string, params: unknown[] = []) => {
  const response = await fetch(rpc.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });

  return await response.json() as { id: number; result?: { context: unknown; value: unknown }; error?: { code: number; message: string } };
};

const tokenAccounts = () => send('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);

describe('the fake Solana RPC', () => {
  it('answers getAccountInfo with a mint of the classic token program and its decimals', async () => {
    const answer = await send('getAccountInfo', [mint, { encoding: 'base64' }]);
    const value = answer.result?.value as { data: [string, string]; owner: string; space: number };

    expect(answer.id).toBe(7);
    expect(value).toMatchObject({ owner: tokenProgramAddress, space: 82 });
    const data = Buffer.from(value.data[0], 'base64');
    expect([data.length, data[44], data[45]]).toEqual([82, 6, 1]);
  });

  it('answers getLatestBlockhash with a fresh 32-byte blockhash', async () => {
    const first = (await send('getLatestBlockhash')).result?.value as { blockhash: string; lastValidBlockHeight: number };
    const second = (await send('getLatestBlockhash')).result?.value as { blockhash: string };

    expect(first.blockhash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(first.lastValidBlockHeight).toBe(1_000);
    expect(second.blockhash).not.toBe(first.blockhash);
  });

  it('answers getTokenAccountsByOwner from the accounts set for the owner and the mint, and none otherwise', async () => {
    expect((await tokenAccounts()).result?.value).toEqual([]);

    rpc.setTokenAccounts(owner, mint, [1_500_000n, 25n]);

    expect((await tokenAccounts()).result?.value).toEqual([1_500_000n, 25n].map(amount => expect.objectContaining({
      account: expect.objectContaining({
        owner: tokenProgramAddress,
        data: expect.objectContaining({ parsed: expect.objectContaining({ info: expect.objectContaining({ mint, owner, tokenAmount: expect.objectContaining({ amount: amount.toString(), decimals: 6 }) }) }) }),
      }),
    })));
  });

  it('fails getTokenAccountsByOwner with an error, or a result without accounts, until told to stop', async () => {
    rpc.setTokenAccounts(owner, mint, [1n]);

    rpc.failTokenAccounts('error');
    expect((await tokenAccounts()).error).toEqual({ code: -32601, message: 'getTokenAccountsByOwner isn\'t faked' });
    rpc.failTokenAccounts('malformed');
    expect((await tokenAccounts()).result).toEqual({ context: { slot: 1 }, value: null });
    rpc.failTokenAccounts(undefined);
    expect((await tokenAccounts()).result?.value).toHaveLength(1);
  });

  it('answers any other method with a JSON-RPC error, and records every call', async () => {
    expect((await send('getBalance', [owner])).error).toEqual({ code: -32601, message: 'getBalance isn\'t faked' });
    await send('getLatestBlockhash');

    expect(rpc.calls).toEqual(['getBalance', 'getLatestBlockhash']);
  });
});

describe('the Solana helpers', () => {
  it('writes base58 with a 1 for each leading zero byte', () => {
    expect(encodeBase58(new Uint8Array(32))).toBe('1'.repeat(32));
    expect(encodeBase58(Uint8Array.from([0, 0, 1]))).toBe('112');
  });

  it('derives the same associated token account every time, distinct per owner', async () => {
    const other = encodeBase58(Uint8Array.from({ length: 32 }, () => 3));

    expect(await associatedTokenAddress(owner, mint)).toBe(await associatedTokenAddress(owner, mint));
    expect(await associatedTokenAddress(owner, mint)).not.toBe(await associatedTokenAddress(other, mint));
  });

  it.each([0, 1] as const)('decodes a partly signed transfer in a version %i message', async version => {
    const authority = await generateKeyPairSigner();
    const feePayer = address(encodeBase58(Uint8Array.from({ length: 32 }, () => 5)));
    const [source, destination] = await Promise.all([associatedTokenAddress(authority.address, mint), associatedTokenAddress(owner, mint)]);
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(1_234n, 1);
    data[9] = 6;
    const transfer = {
      programAddress: address(tokenProgramAddress),
      accounts: [
        { address: address(source), role: AccountRole.WRITABLE },
        { address: address(mint), role: AccountRole.READONLY },
        { address: address(destination), role: AccountRole.WRITABLE },
        { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
      ] as const,
      data: new Uint8Array(data),
    };
    const message = pipe(
      createTransactionMessage({ version }),
      tx => setTransactionMessageFeePayer(feePayer, tx),
      tx => appendTransactionMessageInstructions([transfer], tx),
      tx => setTransactionMessageLifetimeUsingBlockhash({ blockhash: encodeBase58(Uint8Array.from({ length: 32 }, () => 8)) as Blockhash, lastValidBlockHeight: 1_000n }, tx),
    );
    const signed = await partiallySignTransactionMessageWithSigners(message);

    expect(decodeSolanaPayment(getBase64EncodedWireTransaction(signed))).toEqual({
      version,
      feePayer,
      signedBy: [authority.address],
      unsignedBy: [feePayer],
      transfer: { source, mint, destination, authority: authority.address, amount: 1_234n, decimals: 6 },
    });
  });
});
