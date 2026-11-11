'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import type { Period } from '../api/types';
import { startNavigation } from '../components/NavigationProgress';
import { usePending } from '../components/PendingScope';
import { Segmented } from '../components/Segmented';
import { periodChoices, serviceHref } from './content';

/**
 * The period switch of a service's numbers. The period lives in the URL (`?period=`): choosing one moves
 * there, and the server renders that period's numbers.
 */
export const PeriodSwitch = ({ host, period }: { readonly host: string; readonly period: Period }) => {
  const router = useRouter();
  const [chosen, setChosen] = useState(period);
  const [pending, startTransition] = useTransition();
  // The numbers around the switch dim, with `aria-busy`, until the server's answer for the new period is in
  usePending(pending);
  useEffect(() => setChosen(period), [period]);

  return (
    <Segmented
      label="Period"
      options={periodChoices}
      value={chosen}
      onChange={next => {
        setChosen(next);
        startNavigation();
        startTransition(() => router.push(serviceHref(host, next), { scroll: false }));
      }}
    />
  );
};
