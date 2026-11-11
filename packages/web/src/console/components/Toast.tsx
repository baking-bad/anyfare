'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon } from '../../components/Icon';

// Toasts: a short line at the top right that goes away on its own, such as "Account id copied". They stack, three at
// most. A screen reader hears each one.

const shownMs = 3_000;

const Context = createContext<(message: string) => void>(() => undefined);

export const ToastProvider = ({ children }: { readonly children: ReactNode }) => {
  const [toasts, setToasts] = useState<readonly { readonly id: number; readonly message: string }[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;

    return () => {
      for (const timer of pending)
        clearTimeout(timer);
    };
  }, []);

  const show = useCallback((message: string): void => {
    counter.current += 1;
    const id = counter.current;
    setToasts(list => [...list.slice(-2), { id, message }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts(list => list.filter(toast => toast.id !== id));
    }, shownMs);
    timers.current.add(timer);
  }, []);

  return (
    <Context.Provider value={show}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map(toast => <div key={toast.id} className="toast"><Icon name="check" />{toast.message}</div>)}
      </div>
    </Context.Provider>
  );
};

/** Shows a toast. */
export const useToast = (): ((message: string) => void) => useContext(Context);
