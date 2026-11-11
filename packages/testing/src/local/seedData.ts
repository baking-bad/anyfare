import { encodeBase58 } from '../solanaRpc.js';
import type { SeededRandom } from './random.js';

// What the seed makes calls to and with: a few services on the reserved example domains, and the chains
// buyers and the API are paid on.

/** Rows the seed writes carry one of these, in a column no public answer shows. */
export const seedRequestPrefix = 'seed:';
export const seedAccountPrefix = 'acc_seed-';
export const seedKeyPrefix = 'key_seed-';
export const seedTopupPrefix = 'top_seed-';
export const seedLedgerPrefix = 'seed-';

export type ChainName = 'near' | 'base' | 'solana' | 'tempo';

export interface EndpointDefinition {
  readonly path: string;
  readonly method: 'GET' | 'POST';
  // What the API asks, in micro-USD
  readonly price: bigint;
  readonly weight: number;
}

export interface ServiceDefinition {
  readonly host: string;
  readonly weight: number;
  // How we pay this API
  readonly paidOn: ChainName;
  readonly endpoints: readonly EndpointDefinition[];
}

const endpoint = (method: 'GET' | 'POST', path: string, price: number, weight: number): EndpointDefinition => ({ method, path, price: BigInt(price), weight });

// A host of exactly 200 characters: three labels of 60, one of 5, and a domain
const longLabel = 'a'.repeat(60);
export const longHost = `${longLabel}.${'b'.repeat(60)}.${'c'.repeat(60)}.hosts.example.org`;

export const services: readonly ServiceDefinition[] = [
  {
    host: 'api.example.com', weight: 30, paidOn: 'base',
    endpoints: [
      endpoint('GET', '/v1/prices/latest', 2_000, 5), endpoint('GET', '/v1/prices/history', 5_000, 4), endpoint('POST', '/v1/convert', 3_000, 3),
      endpoint('GET', '/v1/markets', 1_000, 2), endpoint('GET', '/v1/markets/depth', 8_000, 1.5), endpoint('POST', '/v1/alerts', 10_000, 1),
    ],
  },
  {
    host: 'data.example.org', weight: 22, paidOn: 'near',
    endpoints: [
      endpoint('GET', '/v1/datasets', 1_000, 5), endpoint('GET', '/v1/datasets/search', 4_000, 4), endpoint('POST', '/v1/query', 20_000, 2), endpoint('GET', '/v1/schema', 500, 1),
    ],
  },
  {
    host: 'weather.example.net', weight: 15, paidOn: 'base',
    endpoints: [endpoint('GET', '/v1/forecast', 1_500, 5), endpoint('GET', '/v1/forecast/hourly', 3_000, 3), endpoint('GET', '/v1/alerts', 800, 1)],
  },
  {
    host: 'search.example.com', weight: 14, paidOn: 'tempo',
    endpoints: [
      endpoint('GET', '/v1/search', 2_500, 5), endpoint('GET', '/v1/search/images', 6_000, 3), endpoint('POST', '/v1/search/batch', 15_000, 1.5),
      endpoint('GET', '/v1/suggest', 400, 3), endpoint('GET', '/v1/trending', 1_200, 1),
    ],
  },
  {
    host: 'maps.example.org', weight: 7, paidOn: 'solana',
    endpoints: [endpoint('GET', '/v1/geocode', 1_800, 4), endpoint('GET', '/v1/route', 7_000, 2)],
  },
  {
    host: 'translate.example.net', weight: 6, paidOn: 'near',
    endpoints: [endpoint('POST', '/v1/translate', 2_200, 5), endpoint('POST', '/v1/translate/document', 25_000, 1), endpoint('GET', '/v1/languages', 300, 2)],
  },
  { host: 'news.example.com', weight: 4, paidOn: 'base', endpoints: [endpoint('GET', '/v1/headlines', 900, 1)] },
  {
    host: 'quotes.example.org', weight: 2, paidOn: 'tempo',
    endpoints: [
      endpoint('GET', '/v1/quote', 1_100, 5), endpoint('GET', '/v1/quote/history', 3_500, 3), endpoint('POST', '/v1/quote/batch', 9_000, 1), endpoint('GET', '/v1/exchanges', 600, 1),
    ],
  },
  { host: longHost, weight: 0.4, paidOn: 'base', endpoints: [endpoint('GET', '/v1/status', 700, 1)] },
];

/** The path of the one call whose path is too long to list: 3,000 characters. */
export const veryLongPath = `/v1/lookup/${'x'.repeat(2_989)}`;
export const veryLongPathService = 'api.example.com';

export const seededHosts: readonly string[] = services.map(service => service.host);

export interface CheckedEndpointDefinition {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  // What the API asks, in micro-USD
  readonly price: bigint;
  // How long before now its check was
  readonly checkedAgoMs: number;
}

export interface CheckedServiceDefinition {
  readonly host: string;
  readonly endpoints: readonly CheckedEndpointDefinition[];
}

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const checkedEndpoint = (method: 'GET' | 'POST', path: string, price: number, checkedAgoMs: number): CheckedEndpointDefinition =>
  ({ method, path, price: BigInt(price), checkedAgoMs });

/** Hosts a check listed and no paid call has reached: checked today, yesterday and 5 days ago. */
export const checkedServices: readonly CheckedServiceDefinition[] = [
  { host: 'invoices.example.com', endpoints: [checkedEndpoint('POST', '/v1/invoices/parse', 12_000, 25 * 60_000), checkedEndpoint('GET', '/v1/invoices/status', 1_500, 40 * 60_000)] },
  { host: 'rates.example.org', endpoints: [checkedEndpoint('GET', '/v1/rates', 600, 3 * hourMs)] },
  {
    host: 'images.example.net',
    endpoints: [
      checkedEndpoint('POST', '/v1/resize', 4_000, dayMs + 2 * hourMs), checkedEndpoint('POST', '/v1/classify', 9_000, dayMs + 2 * hourMs + 60_000),
      checkedEndpoint('GET', '/v1/formats', 300, dayMs + 3 * hourMs),
    ],
  },
  { host: 'geo.example.com', endpoints: [checkedEndpoint('GET', '/v1/lookup', 2_000, dayMs + 8 * hourMs), checkedEndpoint('POST', '/v1/lookup/batch', 7_500, dayMs + 8 * hourMs)] },
  { host: 'speech.example.org', endpoints: [checkedEndpoint('POST', '/v1/transcribe', 30_000, 5 * dayMs + hourMs)] },
  { host: 'legal.example.net', endpoints: [checkedEndpoint('GET', '/v1/clauses', 5_000, 5 * dayMs + 6 * hourMs), checkedEndpoint('POST', '/v1/review', 45_000, 5 * dayMs + 7 * hourMs)] },
];

/** A seeded paid host that also has endpoints a check listed. */
export const checkedOnPaidHost: CheckedServiceDefinition = {
  host: 'weather.example.net',
  endpoints: [checkedEndpoint('GET', '/v1/forecast/daily', 2_400, 2 * hourMs), checkedEndpoint('POST', '/v1/forecast/batch', 11_000, dayMs + 5 * hourMs)],
};

/** Every host the seed writes endpoints for. */
export const allSeededHosts: readonly string[] = [...seededHosts, ...checkedServices.map(service => service.host)];

// --- Addresses and transaction hashes, of the right form for each chain ---

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const repeatedPair = (index: number, pairs: number): string =>
  `${base58Alphabet[index % 58]}${base58Alphabet[(index * 7 + 3) % 58]}`.repeat(pairs);

/** A transaction hash that is clearly made up: a digit pair or two characters, repeated. */
export const fakeTransactionHash = (chain: ChainName, index: number): string => {
  if (chain === 'near')
    return repeatedPair(index, 22);
  if (chain === 'solana')
    return repeatedPair(index, 44);

  return `0x${(((index * 37) % 254) + 1).toString(16).padStart(2, '0').repeat(32)}`;
};

/** The addresses buyers pay from on a chain: NEAR names, EVM addresses, Solana keys. */
export const payerAddresses = (chain: ChainName, count: number, random: SeededRandom): readonly string[] =>
  Array.from({ length: count }, (_, index) => {
    if (chain === 'near')
      return `${index < 40 ? 'sample-agent' : 'sample-bot'}-${String(index + 7).padStart(2, '0')}.near`;
    if (chain === 'solana')
      return encodeBase58(random.bytes(32));

    return `0x${random.hex(40)}`;
  });

/** The address an API is paid at, on a chain. */
export const merchantAddress = (chain: ChainName, serviceIndex: number, random: SeededRandom): string => {
  if (chain === 'near')
    return `merchant-${String(serviceIndex + 1).padStart(2, '0')}.near`;
  if (chain === 'solana')
    return encodeBase58(random.bytes(32));

  return `0x${random.hex(40)}`;
};
