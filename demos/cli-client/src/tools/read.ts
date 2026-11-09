// Helpers for reading an answer that may be missing fields. A missing field prints `-`, never a crash.

import { isRecord } from '../util.ts';

export const DASH = '-';

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A string, or a number as text, or `-`. */
export function textOf(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return DASH;
}

/** A finite number from a number or a numeric string. */
export function numberOf(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

/**
 * Cuts the fraction of a plain decimal, never rounds. `significant` counts digits after the leading
 * zeros of a fraction below one; for a larger number it counts digits after the point.
 */
export function cutFraction(decimal: string, significant: number): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const zeros = whole.replace(/^-/, '') === '0' ? (/^0*/.exec(fraction)?.[0].length ?? 0) : 0;
  const kept = fraction.slice(0, zeros + significant).replace(/0+$/, '');
  return kept === '' ? whole : `${whole}.${kept}`;
}

/** At most `places` fractional digits, cut. */
export function cutPlaces(decimal: string, places: number): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const kept = fraction.slice(0, places).replace(/0+$/, '');
  return kept === '' ? whole : `${whole}.${kept}`;
}

/** The width of the label in an answer line made by `line`. */
export const LABEL_WIDTH = 12;

/** A label and a value as one answer line. */
export function line(label: string, value: string, width = LABEL_WIDTH): string {
  return `${label.padEnd(width)}${value}`;
}
