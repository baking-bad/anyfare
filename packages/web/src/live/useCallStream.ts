'use client';

import { useEffect, useRef, useState } from 'react';

import type { Call } from '../api/types';
import { createCallStream } from './stream';

// How long a hidden page keeps its stream open
export const hiddenGraceMs = 60_000;

/**
 * Follows the calls stream while the page is mounted. It reconnects after a drop, closes when the page
 * has been hidden for a minute, and opens again when the page shows. Returns whether it is connected.
 * `url` is the stream's full address, with the filters in its query. An empty `url` follows nothing.
 */
export const useCallStream = (url: string, onCall: (call: Call) => void): boolean => {
  const [connected, setConnected] = useState(false);
  const latest = useRef(onCall);
  useEffect(() => {
    latest.current = onCall;
  });

  useEffect(() => {
    if (url === '' || typeof EventSource === 'undefined')
      return undefined;
    const stream = createCallStream({ url, onCall: call => latest.current(call), onConnection: setConnected });
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = (): void => {
      clearTimeout(hiddenTimer);
      if (document.visibilityState === 'hidden')
        hiddenTimer = setTimeout(stream.stop, hiddenGraceMs);
      else
        stream.start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState !== 'hidden')
      stream.start();
    else
      onVisibility();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(hiddenTimer);
      stream.stop();
    };
  }, [url]);

  return connected;
};
