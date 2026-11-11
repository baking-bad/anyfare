'use client';

import { useMemo, useState } from 'react';

import type { ServiceDetail } from '../api/types';
import { BarChart } from '../components/BarChart';
import { Card, CardHead } from '../components/Card';
import { Segmented } from '../components/Segmented';

type Series = 'calls' | 'volume' | 'buyers';

const options: readonly { readonly value: Series; readonly label: string }[] = [
  { value: 'calls', label: 'Calls' },
  { value: 'volume', label: 'Volume' },
  { value: 'buyers', label: 'Buyers' },
];

const seriesName: Readonly<Record<Series, string>> = { calls: 'Paid calls per day', volume: 'Volume per day', buyers: 'Buyers per day' };

/** The paid calls of each day, with a switch between calls, volume and buyers. The switch changes the bars without a request. */
export const DailyChart = ({ daily }: { readonly daily: ServiceDetail['daily'] }) => {
  const [series, setSeries] = useState<Series>('calls');
  const data = useMemo(() => daily.map((point, index) => ({
    value: Number(series === 'calls' ? point.calls : series === 'buyers' ? point.buyers : point.volume) || 0,
    label: point.day,
    // A date under every seventh bar, and under the last one
    tick: index % 7 === 0 || index === daily.length - 1 ? point.day.slice(5) : '',
  })), [daily, series]);

  return (
    <Card className="mt-16">
      <CardHead title="Paid calls per day"><Segmented small label="Series" options={options} value={series} onChange={setSeries} /></CardHead>
      <BarChart data={data} unit={series === 'volume' ? 'usd' : 'count'} height={220} label={seriesName[series]} />
      <p className="xs muted mt-8">UTC days. Hover a bar for the number.</p>
    </Card>
  );
};
