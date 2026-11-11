'use client';

import { useEffect, useState } from 'react';

/** The browser's time, ticking each second. It starts at the server's time, so the first render matches. */
export const useNow = (serverNow: number): number => {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(timer);
  }, []);

  return now;
};
