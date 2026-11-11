'use client';

import { useState } from 'react';

import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { RailIcon } from '../../components/Rail';
import { usdOf } from '../../format';
import type { TopupNetwork } from '../api';
import { Dialog } from '../components/Dialog';
import { filterChoices, shortAddress, type TokenChoice } from './options';
import { networkName } from './status';

/**
 * "Pick a token": a search, a chip for each network ("All" first), and the tokens, each with its logo, its network
 * and the least a top-up on it must be worth. The list scrolls inside the dialog. Without the token lists it says
 * so, with "Try again". Escape and Cancel close it, and the focus goes back to the token pill.
 */
export const TokenDialog = ({ networks, choices, chosen, missing, retrying, onRetry, onPick, onClose }: {
  readonly networks: readonly TopupNetwork[];
  readonly choices: readonly TokenChoice[];
  readonly chosen: string | undefined;
  // The options came without their token lists
  readonly missing: boolean;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onPick: (choice: TokenChoice) => void;
  readonly onClose: () => void;
}) => {
  const [query, setQuery] = useState('');
  const [network, setNetwork] = useState('');
  const shown = filterChoices(choices, query, network);

  return (
    <Dialog title="Pick a token" onClose={onClose} footer={<Button variant="outline" onClick={onClose}>Cancel</Button>}>
      {missing || choices.length === 0 ? (
        <div className="stack tok-missing" role="status">
          <p className="muted">The token list can&apos;t be read right now.</p>
          <div><Button variant="secondary" loading={retrying} onClick={onRetry}>Try again</Button></div>
        </div>
      ) : (
        <>
          <div className="search">
            <Icon name="search" />
            <input
              className="input tok-search"
              type="search"
              placeholder={`Search ${choices.length} tokens on ${networks.length} networks`}
              aria-label="Search tokens"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </div>
          <div className="net-chips" role="group" aria-label="Network">
            <button type="button" className="chip net-all" aria-pressed={network === ''} onClick={() => setNetwork('')}>All</button>
            {networks.map(item => (
              <button key={item.name} type="button" className="chip" aria-pressed={network === item.name} onClick={() => setNetwork(item.name)}>
                <RailIcon rail={item.name} />{networkName(item.name)}
              </button>
            ))}
          </div>
          <div className="tok-list" role="list" aria-label="Tokens">
            {shown.length === 0 ? <p className="small muted tok-none" role="listitem">No token matches.</p> : shown.map(choice => (
              <div key={choice.key} role="listitem">
                <button type="button" className="tok" aria-pressed={choice.key === chosen} onClick={() => onPick(choice)}>
                  <RailIcon rail={choice.network} token={choice.symbol} size={32} />
                  <span className="grow">
                    <span className="semi">{choice.symbol}</span>
                    <span className="xs muted">on {networkName(choice.network)}{choice.shared && choice.address !== undefined ? <> · <span className="mono">{shortAddress(choice.address)}</span></> : null}</span>
                  </span>
                  <span className="side xs muted">At least {usdOf(choice.minimum)}</span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
};
