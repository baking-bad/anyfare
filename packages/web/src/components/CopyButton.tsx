'use client';

import { useEffect, useRef, useState } from 'react';

import { Button, type ButtonStyle } from './Button';
import { Icon } from './Icon';

// The Clipboard API needs a secure page; a hidden text area covers the rest
const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  }
  catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'sr-only';
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand('copy');
    }
    catch {
      return false;
    }
    finally {
      area.remove();
    }
  }
};

/**
 * Copies `text` when pressed, by mouse, touch or keyboard, and says "Copied" for a moment. With
 * `iconOnly` it is a square icon button and `label` is its accessible name. `name` is the accessible name of
 * a button that shows text, when the text alone doesn't say what is copied. `withIcon` puts the copy icon
 * before the text.
 */
export const CopyButton = ({ text, label = 'Copy', name, withIcon = false, variant = 'secondary', size = 'sm', iconOnly = false, className }: {
  readonly text: string;
  readonly label?: string;
  readonly name?: string;
  readonly withIcon?: boolean;
} & ButtonStyle) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const press = async () => {
    if (!await copyText(text))
      return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <Button variant={variant} size={size} iconOnly={iconOnly} {...className ? { className } : {}} aria-label={iconOnly ? label : name} onClick={() => void press()}>
      {iconOnly || withIcon ? <Icon name={copied ? 'check' : 'copy'} /> : null}
      {iconOnly ? null : copied ? 'Copied' : label}
      <span className="sr-only" role="status">{copied ? 'Copied' : ''}</span>
    </Button>
  );
};
