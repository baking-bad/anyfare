import type { ReactNode } from 'react';

import { CopyButton } from './CopyButton';

/**
 * Code in a box with a Copy button. `code` is the plain text the button copies; `children` is what shows
 * (the same text, or spans with the classes `k s n b p c ok warn err` for color). `wrap` breaks long lines,
 * `tall` scrolls past 520 px. The box scrolls sideways by keyboard too.
 */
export const CodeBlock = ({ code, children, wrap = false, tall = false, copyLabel = 'Copy' }: {
  readonly code: string;
  readonly children?: ReactNode;
  readonly wrap?: boolean;
  readonly tall?: boolean;
  readonly copyLabel?: string;
}) => (
  <div className="code-block">
    <div className="copy"><CopyButton text={code} label={copyLabel} /></div>
    <pre className={['code', wrap ? 'wrap' : '', tall ? 'tall' : ''].filter(Boolean).join(' ')} tabIndex={0}>{children ?? code}</pre>
  </div>
);
