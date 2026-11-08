import type { Clock } from '@anyfare/common';

export interface FakeClock extends Clock {
  set(time: Date | string): void;
  advance(ms: number): void;
}

/** A clock that moves only when a test moves it. */
export const createFakeClock = (start: Date | string = '2026-11-08T19:50:00+08:00'): FakeClock => {
  let current = new Date(start).getTime();

  return {
    // A new Date each time, so a caller that mutates one doesn't move the clock
    now: () => new Date(current),
    set: time => {
      current = new Date(time).getTime();
    },
    advance: ms => {
      current += ms;
    },
  };
};
