export type RailId = 'near' | 'base' | 'solana' | 'tempo' | 'credits';

const rails: Readonly<Record<RailId, { readonly name: string; readonly letter: string }>> = {
  near: { name: 'NEAR', letter: 'N' },
  base: { name: 'Base', letter: 'B' },
  solana: { name: 'Solana', letter: 'S' },
  tempo: { name: 'Tempo', letter: 'T' },
  credits: { name: 'Credits', letter: '$' },
};

const known = (rail: string): rail is RailId => Object.hasOwn(rails, rail);

// A network that isn't one of the five reads as its own ID, with its first letter
const railOf = (rail: string): { readonly name: string; readonly letter: string } =>
  known(rail) ? rails[rail] : { name: rail, letter: rail.slice(0, 1).toUpperCase() || '?' };

const railTokens: Readonly<Record<string, string>> = { near: 'USDC', base: 'USDC', solana: 'USDC', tempo: 'USDC.e' };

/** The token a way of paying moves, for a list that has only the way: USDC on the x402 chains, USDC.e on Tempo. Credits and an unknown network have none. */
export const railToken = (rail: string): string | undefined => railTokens[rail];

// A token's first letter or digit: "U" for USDC, "W" for wNEAR
const tokenLetter = (token: string): string => token.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? '?';

/**
 * The icon of a way of paying. Without `token`, the network's letter in a circle: NEAR in the brand green, the
 * others gray. With `token`, the token's letter, and the network's letter in a small circle at its bottom right,
 * which carries NEAR's green. Credits have no network, so they are one circle. `size` is the big circle's, in px.
 */
export const RailIcon = ({ rail, token, size = 16 }: { readonly rail: RailId | (string & {}); readonly token?: string | null; readonly size?: 16 | 24 | 32 }) => {
  const tone = rail === 'near' ? ' near' : '';
  const letter = railOf(rail).letter;

  if (token === undefined || token === null || rail === 'credits')
    return <span className={`coin s${size}${tone}`} aria-hidden="true"><i>{letter}</i></span>;

  return (
    <span className={`coin pair s${size}${tone}`} aria-hidden="true">
      <i>{tokenLetter(token)}</i>
      <i className="net">{letter}</i>
    </span>
  );
};

/**
 * The "paid with" chip: NEAR in the brand green, the others gray. `label` replaces the rail's name. With `token`,
 * the icon is the token with the network at its corner, as in "USDC on NEAR".
 */
export const Rail = ({ rail, token, label }: { readonly rail: RailId | (string & {}); readonly token?: string | null; readonly label?: string }) => {
  const pair = token !== undefined && token !== null && rail !== 'credits';

  return (
    <span className={`rail${rail === 'near' ? ' near' : ''}${pair ? ' pair' : ''}`}>
      <RailIcon rail={rail} token={token} />
      {label ?? railOf(rail).name}
    </span>
  );
};
