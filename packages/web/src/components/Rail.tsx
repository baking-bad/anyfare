export type RailId = 'near' | 'base' | 'solana' | 'tempo' | 'credits';

const rails: Readonly<Record<RailId, { readonly name: string; readonly letter: string }>> = {
  near: { name: 'NEAR', letter: 'N' },
  base: { name: 'Base', letter: 'B' },
  solana: { name: 'Solana', letter: 'S' },
  tempo: { name: 'Tempo', letter: 'T' },
  credits: { name: 'Credits', letter: '$' },
};

const known = (rail: string): rail is RailId => Object.hasOwn(rails, rail);

/**
 * The "paid with" chip: NEAR in the brand green, the others gray. `label` replaces the rail's name. A
 * network that isn't one of the five reads as its own ID, with its first letter.
 */
export const Rail = ({ rail, label }: { readonly rail: RailId | (string & {}); readonly label?: string }) => {
  const info = known(rail) ? rails[rail] : { name: rail, letter: rail.slice(0, 1).toUpperCase() || '?' };

  return (
    <span className={rail === 'near' ? 'rail near' : 'rail'}>
      <i aria-hidden="true">{info.letter}</i>
      {label ?? info.name}
    </span>
  );
};
