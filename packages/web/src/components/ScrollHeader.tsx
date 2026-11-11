'use client';

import { useEffect, useState, type ReactNode } from 'react';

/** The sticky header bar. Its bottom line shows once the page has scrolled. */
export const ScrollHeader = ({ children }: { readonly children: ReactNode }) => {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 0);
    update();
    window.addEventListener('scroll', update, { passive: true });

    return () => window.removeEventListener('scroll', update);
  }, []);

  return <header className={scrolled ? 'site-header scrolled' : 'site-header'}>{children}</header>;
};
