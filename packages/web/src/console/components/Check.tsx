'use client';

import type { ReactNode } from 'react';

import { Icon } from '../../components/Icon';

/** A checkbox with its label. The whole line is the tap area, 44 px tall at least. */
export const Check = ({ checked, onChange, children }: { readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly children: ReactNode }) => (
  <label className="check">
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="tick-box" aria-hidden="true"><Icon name="check" /></span>
    <span>{children}</span>
  </label>
);
