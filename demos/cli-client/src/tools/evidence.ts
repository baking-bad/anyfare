import { UsageError, fromAtomic } from '../util.ts';
import { DASH, cutPlaces, line, record, textOf } from './read.ts';
import type { PreparedCall, Tool } from './types.ts';

const ENDPOINT = 'https://merchant-near.mikedotexe.com/v1/evidence/account';
const NO_CODE = '11111111111111111111111111111111';

// NEAR's rule for a named account: 2 to 64 characters, parts joined by one of `.`, `-`, `_`.
const NAMED = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMPLICIT = /^[0-9a-f]{64}$/;

function near(yocto: unknown): string {
  if (typeof yocto !== 'string' || !/^[0-9]+$/.test(yocto)) return DASH;
  return `${cutPlaces(fromAtomic(yocto, 24), 5)} NEAR`;
}

export const evidence: Tool = {
  id: 'evidence',
  name: 'The evidence API',
  about:
    "The evidence API: a NEAR account's balance, proved at a final block. Takes only USDC on NEAR. Takes an account, such as anyfare.near.",
  async prepare(args): Promise<PreparedCall> {
    if (args.tool !== 'evidence') throw new Error('The evidence tool got the arguments of another tool');
    const account = args.account;
    if (!NAMED.test(account) && !IMPLICIT.test(account)) {
      throw new UsageError(
        `--account must be a NEAR account ID: 2 to 64 lowercase letters, digits, "-", "_" or ".", such as --account anyfare.near (got "${account}")`,
      );
    }
    return {
      tool: 'evidence',
      request: {
        method: 'POST',
        url: ENDPOINT,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: account }),
      },
      summary: `Account ${account}`,
      slow: true,
      format(answer) {
        const root = record(answer);
        const data = record(root['account']);
        const block = record(root['block']);
        const codeHash = data['codeHash'];
        const storage = data['storageUsage'];
        return [
          line('Account', textOf(data['accountId'])),
          line('Balance', near(data['amountYoctoNear'])),
          line('Storage', typeof storage === 'number' ? `${storage} bytes` : DASH),
          line('Contract', typeof codeHash === 'string' ? (codeHash === NO_CODE ? 'no' : 'yes') : DASH),
          line('Block', `${textOf(block['height'])} (${textOf(block['hash'])})`),
          line('Finality', textOf(root['observedFinality'])),
          line('Observed', textOf(root['observedAt'])),
        ];
      },
    };
  },
};
