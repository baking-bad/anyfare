'use client';

import { useState } from 'react';

import { Button } from '../components/Button';
import { CopyButton } from '../components/CopyButton';
import { Check } from './components/Check';
import { Dialog } from './components/Dialog';
import { KeyOnce } from './components/KeyOnce';

/**
 * A new master key, shown once: after a sign-up, and after a rotation. It doesn't close on Escape or on a click
 * outside. Continue waits for the box "I saved it somewhere safe". The key is in the state of the component that
 * renders this dialog, and goes when that state is cleared. `problem` is a line to show above the box, such as a
 * browser that didn't keep the key. With `onClose`, a Close button shows once the box is ticked; Escape still doesn't close.
 */
export const NewKeyDialog = ({ title, lead, masterKey, problem, onContinue, onClose }: {
  readonly title: string;
  readonly lead: string;
  readonly masterKey: string;
  readonly problem?: string;
  readonly onContinue: () => void;
  readonly onClose?: () => void;
}) => {
  const [saved, setSaved] = useState(false);

  return (
    <Dialog
      title={title}
      icon="check"
      tone="brand"
      footer={(
        <>
          <CopyButton text={masterKey} label="Copy" name="Copy the master key" withIcon size="md" />
          {onClose !== undefined && saved ? <Button variant="outline" onClick={onClose}>Close</Button> : null}
          <Button disabled={!saved} onClick={onContinue}>Continue</Button>
        </>
      )}
    >
      <p className="muted small">{lead}</p>
      <KeyOnce value={masterKey} label="Master key" copy={false} />
      {problem === undefined ? null : <p className="small field-error" role="alert">{problem}</p>}
      <Check checked={saved} onChange={setSaved}>I saved it somewhere safe</Check>
    </Dialog>
  );
};
