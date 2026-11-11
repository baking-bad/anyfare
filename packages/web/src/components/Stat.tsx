import type { ReactNode } from 'react';

/** A big number over its label, with an optional note line. `small` is the 28 px size for cards. */
export const Stat = ({ value, label, note, small = false }: {
  readonly value: ReactNode;
  readonly label: ReactNode;
  readonly note?: ReactNode;
  readonly small?: boolean;
}) => (
  <div className="stat">
    <span className={small ? 'v sm' : 'v'}>{value}</span>
    <span className="l">{label}</span>
    {note === undefined ? null : <span className="n">{note}</span>}
  </div>
);
