export type RailId = 'near' | 'base' | 'solana' | 'tempo' | 'credits';

const rails: Readonly<Record<RailId, { readonly name: string; readonly letter: string }>> = {
  near: { name: 'NEAR', letter: 'N' },
  base: { name: 'Base', letter: 'B' },
  solana: { name: 'Solana', letter: 'S' },
  tempo: { name: 'Tempo', letter: 'T' },
  credits: { name: 'Credits', letter: '$' },
};

/** The "paid with" chip: NEAR in the brand green, the others gray. `label` replaces the rail's name. */
export const Rail = ({ rail, label }: { readonly rail: RailId; readonly label?: string }) => (
  <span className={rail === 'near' ? 'rail near' : 'rail'}>
    <i aria-hidden="true">{rails[rail].letter}</i>
    {label ?? rails[rail].name}
  </span>
);
