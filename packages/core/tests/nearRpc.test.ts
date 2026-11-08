import { describe, expect, it } from 'vitest';

import { InvalidEnvironmentError } from '@anyfare/common';

import { findNetwork, nearNetworkOf, publicNearRpcUrls, readNearRpc, type Asset } from '../src/index.js';

const assetOn = (networkId: string) => ({ network: findNetwork(networkId)! }) as Asset;
const testnet = { assets: [assetOn('eip155:84532'), assetOn('near:testnet')] };
const mainnet = { assets: [assetOn('eip155:8453'), assetOn('near:mainnet')] };

describe('the NEAR RPC for the Signer', () => {
  it('takes the config\'s network from its NEAR asset', () => {
    expect(nearNetworkOf(testnet)?.id).toBe('near:testnet');
    expect(nearNetworkOf({ assets: [assetOn('eip155:8453')] })).toBeUndefined();
  });

  it('takes the first item of NEAR_RPC_URLS for the network as a secret, with a key in its path, and logs only its host', () => {
    const rpc = readNearRpc({ NEAR_RPC_URLS: 'near:testnet=https://near.rpc.test/near-key-secret?apikey=near-query-secret, near:testnet=https://other.rpc.test' }, testnet);

    expect(rpc?.url.expose()).toBe('https://near.rpc.test/near-key-secret?apikey=near-query-secret');
    expect(rpc?.host).toBe('near.rpc.test');
    expect(rpc?.public).toBe(false);
    expect(JSON.stringify(rpc)).not.toContain('near-key-secret');
    expect(JSON.stringify(rpc)).not.toContain('near-query-secret');
  });

  it('falls back to the x402 SDK\'s public RPC of the network without NEAR_RPC_URLS', () => {
    expect(readNearRpc({}, mainnet)).toMatchObject({ host: 'rpc.mainnet.fastnear.com', public: true });
    expect(readNearRpc({ NEAR_RPC_URLS: ' ' }, testnet)?.url.expose()).toBe(publicNearRpcUrls['near:testnet']);
  });

  it('is undefined when the config has no NEAR asset, whatever NEAR_RPC_URLS holds', () => {
    expect(readNearRpc({ NEAR_RPC_URLS: 'not-an-item' }, { assets: [assetOn('eip155:8453')] })).toBeUndefined();
  });

  it.each([
    ['an item without a network', 'https://near.rpc.test/near-key-secret', /^NEAR_RPC_URLS must be near:<network>=<HTTP\(S\) URL> items/],
    ['another namespace', 'eip155:8453=https://near.rpc.test/near-key-secret', /^NEAR_RPC_URLS must be near:<network>=<HTTP\(S\) URL> items/],
    ['a URL that isn\'t HTTP(S)', 'near:testnet=ftp://near.rpc.test/near-key-secret', /^NEAR_RPC_URLS must be near:<network>=<HTTP\(S\) URL> items/],
    ['a URL that doesn\'t parse', 'near:testnet=near.rpc.test/near-key-secret', /^NEAR_RPC_URLS must be near:<network>=<HTTP\(S\) URL> items/],
    ['a username and password', 'near:testnet=https://user:near-key-secret@near.rpc.test', /^NEAR_RPC_URLS can't carry a username or password/],
    ['another NEAR network than the config\'s', 'near:mainnet=https://near.rpc.test/near-key-secret', /^NEAR_RPC_URLS names near:mainnet, but the platform config's NEAR network is near:testnet$/],
  ])('refuses %s without echoing it', (_name, value, message) => {
    const failure = (() => {
      try {
        readNearRpc({ NEAR_RPC_URLS: value }, testnet);
      }
      catch (error) {
        return error as Error;
      }

      return undefined;
    })();

    expect(failure).toBeInstanceOf(InvalidEnvironmentError);
    expect(failure?.message).toMatch(message);
    expect(failure?.message).not.toContain('near-key-secret');
  });
});
