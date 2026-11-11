'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** The settings a browser needs. The server reads them per request and hands them down; nothing is built in. */
export interface PublicSettings {
  // The public Platform API
  readonly apiUrl: string;
  readonly payUrl: string;
  readonly consoleUrl: string;
}

const Context = createContext<PublicSettings | undefined>(undefined);

export const SettingsProvider = ({ value, children }: { readonly value: PublicSettings; readonly children: ReactNode }) => (
  <Context.Provider value={value}>{children}</Context.Provider>
);

/** The settings from the layout's provider. */
export const useSettings = (): PublicSettings => {
  const value = useContext(Context);
  if (value === undefined)
    throw new Error('useSettings needs a SettingsProvider above it');

  return value;
};
