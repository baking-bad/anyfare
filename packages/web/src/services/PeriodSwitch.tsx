'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import type { Period } from '../api/types';
import { Segmented } from '../components/Segmented';
import { periodChoices, serviceHref } from './content';

/**
 * The period switch of a service's numbers. The period lives in the URL (`?period=`): choosing one moves
 * there, and the server renders that period's numbers.
 */
export const PeriodSwitch = ({ host, period }: { readonly host: string; readonly period: Period }) => {
  const router = useRouter();
  const [chosen, setChosen] = useState(period);
  const [, startTransition] = useTransition();
  useEffect(() => setChosen(period), [period]);

  return (
    <Segmented
      label="Period"
      options={periodChoices}
      value={chosen}
      onChange={next => {
        setChosen(next);
        startTransition(() => router.push(serviceHref(host, next), { scroll: false }));
      }}
    />
  );
};
