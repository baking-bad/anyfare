import { UsageError, isRecord } from '../util.ts';
import { DASH, line, numberOf, record, textOf } from './read.ts';
import type { PreparedCall, Tool } from './types.ts';

const ENDPOINT = 'https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest';
const PAIR = /^([A-Za-z0-9]+)\/([A-Za-z0-9]+)$/;

const US = 'en-US';

function plainNumber(value: unknown, maxFraction: number): string {
  const number = numberOf(value);
  return number === undefined ? DASH : number.toLocaleString(US, { maximumFractionDigits: maxFraction });
}

function price(value: unknown): string {
  const number = numberOf(value);
  if (number === undefined) return DASH;
  // Below one, a fixed number of decimals would show nothing at all.
  return number.toLocaleString(US, number >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 6 });
}

function change(value: unknown): string {
  const number = numberOf(value);
  if (number === undefined) return DASH;
  return `${number < 0 ? '-' : '+'}${Math.abs(number).toFixed(2)}%`;
}

function assets(data: unknown): Record<string, unknown>[] {
  const items = Array.isArray(data) ? data : isRecord(data) ? Object.values(data).flat() : [];
  return items.filter(isRecord);
}

function isActive(asset: Record<string, unknown>): boolean {
  const flag = asset['is_active'];
  return flag === undefined || flag === 1 || flag === true || flag === '1';
}

/** A ticker is not unique: the active asset with this symbol and the lowest rank. */
function pickAsset(data: unknown, symbol: string): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestRank = Infinity;
  for (const asset of assets(data)) {
    if (!isActive(asset)) continue;
    if (typeof asset['symbol'] !== 'string' || asset['symbol'].toUpperCase() !== symbol) continue;
    const rank = numberOf(asset['cmc_rank']) ?? Infinity;
    if (best === undefined || rank < bestRank) {
      best = asset;
      bestRank = rank;
    }
  }
  return best;
}

function pickQuote(asset: Record<string, unknown>, currency: string): Record<string, unknown> {
  const quote = asset['quote'];
  if (Array.isArray(quote)) {
    const items = quote.filter(isRecord);
    return items.find((item) => String(item['symbol']).toUpperCase() === currency) ?? items[0] ?? {};
  }
  const byCurrency = record(quote)[currency];
  return isRecord(byCurrency) ? byCurrency : record(quote);
}

export const cmc: Tool = {
  id: 'cmc',
  name: 'CoinMarketCap',
  about: 'CoinMarketCap: the latest price of a coin. Takes a pair, such as BTC/USD.',
  async prepare(args): Promise<PreparedCall> {
    if (args.tool !== 'cmc') throw new Error('The CoinMarketCap tool got the arguments of another tool');
    const match = PAIR.exec(args.pair);
    if (match === null) {
      throw new UsageError(
        `--pair must be a symbol and a currency with a slash, letters and digits only, such as --pair BTC/USD (got "${args.pair}")`,
      );
    }
    const symbol = (match[1] ?? '').toUpperCase();
    const currency = (match[2] ?? '').toUpperCase();
    return {
      tool: 'cmc',
      request: { method: 'GET', url: `${ENDPOINT}?symbol=${symbol}&convert=${currency}` },
      summary: `${symbol} in ${currency}`,
      slow: false,
      format(answer) {
        const asset = pickAsset(record(answer)['data'], symbol);
        if (asset === undefined) {
          return [`CoinMarketCap listed no active asset with the symbol ${symbol}.`];
        }
        const quote = pickQuote(asset, currency);
        const priceText = price(quote['price']);
        return [
          `${textOf(asset['name'])} (${textOf(asset['symbol'])})`,
          line('Price', priceText === DASH ? DASH : `${priceText} ${currency}`),
          line('24h', change(quote['percent_change_24h'])),
          line('Market cap', plainNumber(quote['market_cap'], 0)),
          line('Updated', textOf(quote['last_updated'])),
        ];
      },
    };
  },
};
