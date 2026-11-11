'use client';

import { useLinkStatus } from 'next/link';

import { Spinner } from '../components/Spinner';

/** Inside a `Link`: a spinner while the link's page is loading. A check can take several seconds, so the visitor sees it run. */
export const LinkPending = () => {
  const { pending } = useLinkStatus();

  return pending ? <Spinner label="Checking the link" /> : null;
};
