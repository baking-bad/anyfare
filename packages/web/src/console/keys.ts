import type { KeyFields, PaymentKey } from './api';

// What the Keys page works out from the API's keys and from its form: no network, no React.

export const maxLabelLength = 60;

/** The form of a key: every field as the person typed it. `expires` is a day, `yyyy-mm-dd`, or empty. */
export interface KeyForm {
  readonly label: string;
  readonly dailyBudget: string;
  readonly maxPrice: string;
  readonly allowance: string;
  readonly expires: string;
}

export type FormField = keyof KeyForm;

export const emptyKeyForm: KeyForm = { label: '', dailyBudget: '5.00', maxPrice: '', allowance: '', expires: '' };

const decimal = /^\d{1,12}(?:\.\d{1,6})?$/;
const day = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The name a key goes by. */
export const keyName = (key: PaymentKey): string => key.label ?? 'No name';

/** The day of a moment, `yyyy-mm-dd`, in UTC. */
export const dayOf = (iso: string): string => iso.slice(0, 10);

/** The form filled from a key, for "Change limits". */
export const formOfKey = (key: PaymentKey): KeyForm => ({
  label: key.label ?? '',
  dailyBudget: key.dailyBudget,
  maxPrice: key.maxPrice ?? '',
  allowance: key.allowance ?? '',
  expires: key.expiresAt === null ? '' : dayOf(key.expiresAt),
});

/** The end of a day in UTC, as a full ISO time, or undefined when `date` is not a real day. */
export const endOfDay = (date: string): string | undefined => {
  const match = day.exec(date);
  if (match === null)
    return undefined;
  const at = new Date(`${date}T23:59:59.000Z`);

  return Number.isNaN(at.getTime()) || at.getUTCMonth() + 1 !== Number(match[2]) || at.getUTCDate() !== Number(match[3]) ? undefined : at.toISOString();
};

const amountProblem = (name: string, text: string, optional: boolean): string | undefined => {
  if (text === '')
    return optional ? undefined : `${name} is needed`;
  if (!decimal.test(text))
    return `${name} is a number in USD with at most 6 decimals, such as 5.00`;

  return Number(text) > 0 ? undefined : `${name} must be more than 0`;
};

/** What is wrong with a form, field by field. An empty object means it can be sent. `now` is a time in ms. */
export const formProblems = (form: KeyForm, now: number): Partial<Record<FormField, string>> => {
  const problems: Partial<Record<FormField, string>> = {};
  if (form.label.trim().length > maxLabelLength)
    problems.label = `The name is at most ${maxLabelLength} characters`;
  const daily = amountProblem('Per day', form.dailyBudget.trim(), false);
  if (daily !== undefined)
    problems.dailyBudget = daily;
  const price = amountProblem('Per call', form.maxPrice.trim(), true);
  if (price !== undefined)
    problems.maxPrice = price;
  const total = amountProblem('In total', form.allowance.trim(), true);
  if (total !== undefined)
    problems.allowance = total;
  if (form.expires !== '') {
    const end = endOfDay(form.expires);
    if (end === undefined)
      problems.expires = 'Expires is a day';
    else if (Date.parse(end) <= now)
      problems.expires = 'Expires is a day in the future';
  }

  return problems;
};

/** The body of a new key: the fields that are filled. */
export const newKeyBody = (form: KeyForm): KeyFields => {
  const label = form.label.trim();
  const expiresAt = form.expires === '' ? undefined : endOfDay(form.expires);

  return {
    ...label === '' ? {} : { label },
    dailyBudget: form.dailyBudget.trim(),
    ...form.maxPrice.trim() === '' ? {} : { maxPrice: form.maxPrice.trim() },
    ...form.allowance.trim() === '' ? {} : { allowance: form.allowance.trim() },
    ...expiresAt === undefined ? {} : { expiresAt },
  };
};

const sameAmount = (typed: string, kept: string | null): boolean => typed === '' ? kept === null : kept !== null && Number(typed) === Number(kept);

/**
 * The body of a change: only the fields that differ from the key, and `null` for a field that was emptied. An
 * expiry day that is the key's own day is not sent, so its time of day stays.
 */
export const changeBody = (form: KeyForm, key: PaymentKey): KeyFields => {
  const label = form.label.trim();
  const body: { -readonly [Name in keyof KeyFields]: KeyFields[Name] } = {};
  if (label !== (key.label ?? ''))
    body.label = label === '' ? null : label;
  if (!sameAmount(form.dailyBudget.trim(), key.dailyBudget))
    body.dailyBudget = form.dailyBudget.trim();
  if (!sameAmount(form.maxPrice.trim(), key.maxPrice))
    body.maxPrice = form.maxPrice.trim() === '' ? null : form.maxPrice.trim();
  if (!sameAmount(form.allowance.trim(), key.allowance))
    body.allowance = form.allowance.trim() === '' ? null : form.allowance.trim();
  if (form.expires !== (key.expiresAt === null ? '' : dayOf(key.expiresAt)))
    body.expiresAt = form.expires === '' ? null : endOfDay(form.expires) ?? null;

  return body;
};

/** Whether a key's time is up. */
export const isExpired = (key: PaymentKey, now: number): boolean => key.expiresAt !== null && Date.parse(key.expiresAt) <= now;

/** A key that can still pay: not revoked, not expired. */
export const isActive = (key: PaymentKey, now: number): boolean => key.revokedAt === null && !isExpired(key, now);

/** The keys in the order the table shows them: the active ones as the API lists them, then the revoked ones. */
export const keysInOrder = (keys: readonly PaymentKey[]): readonly PaymentKey[] => [...keys.filter(key => key.revokedAt === null), ...keys.filter(key => key.revokedAt !== null)];

const micros = (amount: string): number => Math.round(Number(amount) * 1_000_000);

/** The sum of what the keys spent today, in dollars. */
export const spentToday = (keys: readonly PaymentKey[]): number => keys.reduce((sum, key) => sum + micros(key.spent.today), 0) / 1_000_000;

/** How much of its day's budget a key spent, from 0 to 1. */
export const budgetShare = (key: PaymentKey): number => {
  const budget = Number(key.dailyBudget);

  return budget > 0 ? Math.min(1, Math.max(0, Number(key.spent.today) / budget)) : 0;
};

/** The class that sets the width of a budget bar: a step of 5 %, `bar-0` to `bar-100`. */
export const barClass = (share: number): string => `bar-${Math.round(share * 20) * 5}`;

/** The bar turns yellow above 80 %. */
export const isHot = (share: number): boolean => share > 0.8;
