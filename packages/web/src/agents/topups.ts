// The states of a top-up, as the API's `status` says them, and what each means. tests/agentsTruth.test.ts checks
// them against the code's list.

export interface TopupState {
  readonly status: string;
  readonly meaning: string;
  // After a final state a top-up does not change
  readonly final: boolean;
}

export const topupStates: readonly TopupState[] = [
  { status: 'quoting', meaning: 'Getting a deposit address.', final: false },
  { status: 'waiting', meaning: 'Waiting for your transfer.', final: false },
  { status: 'incomplete', meaning: 'Received less than the least to send. Send the rest before payBy.', final: false },
  { status: 'processing', meaning: 'Received. Converting.', final: false },
  { status: 'credited', meaning: 'Added to your balance.', final: true },
  { status: 'quote_failed', meaning: 'No deposit address: the quote was refused. Nothing to send.', final: true },
  { status: 'quote_unknown', meaning: 'No deposit address: the quote did not answer. Nothing to send. Ask again.', final: true },
  { status: 'expired', meaning: 'The time to pay ran out. Do not send to this address.', final: true },
  { status: 'refunded', meaning: 'Not added. Anyfare holds the amount and will return it.', final: true },
  { status: 'failed', meaning: 'Stopped. Anyfare is looking into it.', final: true },
];
