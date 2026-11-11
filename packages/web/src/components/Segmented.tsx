import type { ReactNode } from 'react';

export interface SegmentedOption<TValue extends string> {
  readonly value: TValue;
  readonly label: ReactNode;
}

/**
 * A row of buttons where one is chosen, such as a period. It holds no state: pass `value` and `onChange`,
 * from a client component. `onDark` is for the dark bands.
 */
export const Segmented = <TValue extends string>({ options, value, onChange, label, small = false, onDark = false }: {
  readonly options: readonly SegmentedOption<TValue>[];
  readonly value: TValue;
  readonly onChange: (value: TValue) => void;
  readonly label: string;
  readonly small?: boolean;
  readonly onDark?: boolean;
}) => (
  <div className={['seg', small ? 'sm' : '', onDark ? 'on-dark' : ''].filter(Boolean).join(' ')} role="group" aria-label={label}>
    {options.map(option => (
      <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>
    ))}
  </div>
);
