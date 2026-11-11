import type { Topup } from '../api';

// What the view of one top-up shows for its status, worked out from the API's answer and the time: no network, no React.

export const topupStatuses = ['quoting', 'quote_failed', 'quote_unknown', 'waiting', 'incomplete', 'processing', 'credited', 'refunded', 'failed', 'expired'] as const;

/** Whether a status may still change: the page reads the top-up again while it is one of these. */
export const isOpenStatus = (status: string): boolean => status === 'quoting' || status === 'waiting' || status === 'incomplete' || status === 'processing';

/**
 * What the left card shows. `timeUp` is a top-up still `waiting` or `incomplete` whose time to pay ran out by the
 * page's clock: its address goes at once, before the API says `expired`. `noAddress` is a quote that made none, and
 * `unknown` a status this code doesn't know.
 */
export type TopupViewKind = 'quoting' | 'waiting' | 'incomplete' | 'timeUp' | 'processing' | 'credited' | 'refunded' | 'expired' | 'failed' | 'noAddress' | 'unknown';

const kinds: Readonly<Record<string, TopupViewKind>> = {
  quoting: 'quoting',
  waiting: 'waiting',
  incomplete: 'incomplete',
  processing: 'processing',
  credited: 'credited',
  refunded: 'refunded',
  expired: 'expired',
  failed: 'failed',
  quote_failed: 'noAddress',
  quote_unknown: 'noAddress',
};

/** The time left to pay, in milliseconds, never under 0. A `payBy` that isn't a time has none left. */
export const timeLeft = (payBy: string, now: number): number => {
  const at = Date.parse(payBy);

  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
};

/** The view of a top-up at `now`. */
export const viewOf = (topup: Pick<Topup, 'status' | 'payBy'>, now: number): TopupViewKind => {
  const kind = Object.hasOwn(kinds, topup.status) ? kinds[topup.status]! : 'unknown';

  return (kind === 'waiting' || kind === 'incomplete') && timeLeft(topup.payBy, now) === 0 ? 'timeUp' : kind;
};

/** Whether the view shows the deposit address: only while the API says `waiting` or `incomplete`, time is left, and there is an address. */
export const showsAddress = (topup: Pick<Topup, 'status' | 'payBy' | 'depositAddress'>, now: number): boolean => {
  const kind = viewOf(topup, now);

  return (kind === 'waiting' || kind === 'incomplete') && topup.depositAddress !== null;
};

/** Whether the countdown runs: the API says `waiting` or `incomplete`. */
export const counts = (status: string): boolean => status === 'waiting' || status === 'incomplete';

/** The time left as "HH:MM:SS": 59 minutes and 8 seconds is "00:59:08". */
export const countdownText = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const two = (value: number): string => String(value).padStart(2, '0');

  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
};

/** A moment's time of day in UTC, to the second: "10:42:05 UTC". */
export const utcClock = (moment: number): string => {
  const at = new Date(moment);
  const two = (value: number): string => String(value).padStart(2, '0');

  return Number.isNaN(at.getTime()) ? '-' : `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} UTC`;
};

/** A step of the four: done, the one under way, stopped there, or still to come. */
export type StepMark = 'done' | 'now' | 'stopped' | 'next';

export const stepTitles = ['Address made', 'Your transfer arrives', 'Converted to USDC on NEAR', 'Credits added'] as const;

/** The marks of the four steps for a view. A refund or a failure stops at the step it reached. */
export const stepMarks = (kind: TopupViewKind, deposited: string | null): readonly StepMark[] => {
  const marks = (done: number, last: 'now' | 'stopped' | 'none'): readonly StepMark[] =>
    stepTitles.map((_title, index) => index < done ? 'done' : index === done && last !== 'none' ? last : 'next');
  switch (kind) {
    case 'quoting':
      return marks(0, 'now');
    case 'noAddress':
      return marks(0, 'stopped');
    case 'waiting':
    case 'incomplete':
      return marks(1, 'now');
    case 'timeUp':
    case 'expired':
      return marks(1, 'stopped');
    case 'processing':
      return marks(2, 'now');
    case 'refunded':
      return marks(2, 'stopped');
    case 'failed':
      return deposited === null ? marks(1, 'stopped') : marks(2, 'stopped');
    case 'credited':
      return marks(4, 'none');
    default:
      return marks(0, 'none');
  }
};

const plainWords = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Whether the API's message says what the page's own line says, so the page shows it once: "Received. Converting"
 * and "Received. Converting." are one. One that starts the other counts too.
 */
export const saysTheSame = (message: string, line: string): boolean => {
  const [one, other] = [plainWords(message), plainWords(line)];

  return one !== '' && other !== '' && (one.startsWith(other) || other.startsWith(one));
};
