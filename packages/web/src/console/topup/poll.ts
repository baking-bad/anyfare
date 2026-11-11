// Reading an open top-up again every few seconds while the tab is visible: no React, so a test drives it with its own
// clock and its own visibility.

/** How often the page reads an open top-up again. */
export const pollMs = 5_000;

export interface PollClock {
  readonly schedule: (run: () => void, ms: number) => unknown;
  readonly cancel: (handle: unknown) => void;
}

export interface PollPage {
  readonly visible: () => boolean;
  // Calls `listener` when the tab is shown or hidden; returns what stops that
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

export interface Poll<TValue> {
  readonly read: () => Promise<TValue>;
  readonly onRead: (value: TValue) => void;
  readonly onFail: (error: unknown) => void;
  // A value after which there is nothing more to read
  readonly done: (value: TValue) => boolean;
}

export const timers: PollClock = {
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The browser's tab: hidden when `document.visibilityState` says so. */
export const documentPage: PollPage = {
  visible: () => document.visibilityState !== 'hidden',
  onVisibilityChange: listener => {
    document.addEventListener('visibilitychange', listener);

    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/**
 * Reads `every` ms after the last answer while the tab is visible, one read at a time. A hidden tab reads nothing;
 * when it shows again it reads at once. A failed read is reported and tried again; a read that is `done` ends it.
 * With `immediate` the first read is at once. Returns the function that stops it: an answer that comes after is dropped.
 */
export const startPolling = <TValue,>(poll: Poll<TValue>, page: PollPage, clock: PollClock = timers, every = pollMs, immediate = false): (() => void) => {
  let stopped = false;
  let finished = false;
  let reading = false;
  let timer: unknown;
  const clear = (): void => {
    if (timer !== undefined)
      clock.cancel(timer);
    timer = undefined;
  };
  const later = (): void => {
    clear();
    if (!stopped && !finished && page.visible())
      timer = clock.schedule(tick, every);
  };
  function tick(): void {
    timer = undefined;
    if (stopped || finished || reading || !page.visible())
      return;
    reading = true;
    poll.read().then(
      value => {
        reading = false;
        if (stopped)
          return;
        poll.onRead(value);
        if (poll.done(value))
          finished = true;
        else
          later();
      },
      (error: unknown) => {
        reading = false;
        if (stopped)
          return;
        poll.onFail(error);
        later();
      },
    );
  }
  const unsubscribe = page.onVisibilityChange(() => {
    if (stopped || finished)
      return;
    clear();
    if (page.visible())
      tick();
  });
  if (immediate)
    tick();
  else
    later();

  return () => {
    stopped = true;
    clear();
    unsubscribe();
  };
};
