'use client';

import { CopyButton } from '../../components/CopyButton';

/**
 * A key shown once, in a mono box that wraps at any character, with a Copy button under it unless `copy` is false
 * (a dialog may put its own in its footer). The component that shows it holds the key in its state, and nothing else.
 */
export const KeyOnce = ({ value, label, copy = true }: { readonly value: string; readonly label: string; readonly copy?: boolean }) => (
  <div className="key-once">
    <span className="sr-only">{label}</span>
    <code className="key-once-value">{value}</code>
    {copy ? <div className="row"><CopyButton text={value} label="Copy" name={`Copy the ${label.toLowerCase()}`} withIcon size="md" /></div> : null}
  </div>
);
