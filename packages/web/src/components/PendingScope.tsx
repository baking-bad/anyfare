'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const Context = createContext<((pending: boolean) => void) | undefined>(undefined);

/**
 * A part of a page that shows old numbers while new ones load: it dims and says `aria-busy`. A control inside
 * tells it with `usePending(pending)`. The children stay server-rendered.
 */
export const PendingScope = ({ children, label = 'Loading the numbers' }: { readonly children: ReactNode; readonly label?: string }) => {
  const [pending, setPending] = useState(false);

  return (
    <Context.Provider value={setPending}>
      <div className="pending-scope" aria-busy={pending} data-pending={pending ? 'true' : undefined}>
        {children}
        <span className="sr-only" role="status">{pending ? label : ''}</span>
      </div>
    </Context.Provider>
  );
};

/** Inside a `PendingScope`: says whether the scope's numbers are being replaced. */
export const usePending = (pending: boolean): void => {
  const set = useContext(Context);
  useEffect(() => {
    set?.(pending);

    return () => set?.(false);
  }, [pending, set]);
};
