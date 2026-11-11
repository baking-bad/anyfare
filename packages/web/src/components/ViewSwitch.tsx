'use client';

import { Icon } from './Icon';
import { setView, useView } from './view';

/** The Human / Agent switch. The choice is kept in this browser, and the pages that feed an Agent view show it. */
export const ViewSwitch = ({ className = '' }: { readonly className?: string }) => {
  const view = useView();

  return (
    <div className={`seg sm view-switch ${className}`.trim()} role="group" aria-label="Who reads this page">
      <button type="button" aria-pressed={view === 'human'} onClick={() => setView('human')}><Icon name="user" />Human</button>
      <button type="button" aria-pressed={view === 'agent'} onClick={() => setView('agent')}><Icon name="bot" />Agent</button>
    </div>
  );
};
