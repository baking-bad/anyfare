'use client';

import { useState } from 'react';

import { Pager } from '../../../src/components/Pager';
import { Segmented } from '../../../src/components/Segmented';
import { Button } from '../../../src/components/Button';

const periods = [
  { value: 'today', label: 'Today' },
  { value: 'd7', label: '7 days' },
  { value: 'd30', label: '30 days' },
  { value: 'all', label: 'All' },
] as const;

type Period = typeof periods[number]['value'];

/** The parts that hold state: the segmented control, the pager, a loading button. */
export const InteractiveDemo = () => {
  const [period, setPeriod] = useState<Period>('d30');
  const [small, setSmall] = useState<Period>('d7');
  const [page, setPage] = useState(3);
  const [loading, setLoading] = useState(false);

  return (
    <div className="stack-lg">
      <div className="row">
        <Segmented options={periods} value={period} onChange={setPeriod} label="Period" />
        <Segmented options={periods} value={small} onChange={setSmall} label="Period, small" small />
        <span className="small muted">Chosen: {period}, {small}</span>
      </div>
      <div className="inverse-band dark-panel">
        <Segmented options={periods} value={period} onChange={setPeriod} label="Period, on a dark band" onDark />
      </div>
      <div className="card flush">
        <Pager page={page} size={20} total={240} onPage={setPage} />
      </div>
      <div className="card flush">
        <Pager page={1} size={20} total={0} onPage={setPage} />
      </div>
      <div className="row">
        <Button loading={loading} onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1_500); }}>Press for 1.5 s</Button>
        <Button variant="outline" loading>Loading</Button>
      </div>
    </div>
  );
};
