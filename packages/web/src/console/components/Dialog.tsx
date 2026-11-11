'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Icon, type IconName } from '../../components/Icon';
import { useFocusTrap } from './focus';

export type DialogTone = 'neutral' | 'brand' | 'danger';

/**
 * A dialog over the page: a title with an icon circle above it, a body, and a footer of buttons. It is modal: the
 * focus stays inside it, and the page behind doesn't scroll. With `onClose` it closes on Escape and on a click outside;
 * without it, only a button of its own closes it. On a phone it is a drawer from the bottom. Render it only while it is
 * open, so what it holds goes when it closes.
 */
export const Dialog = ({ title, icon, tone = 'neutral', onClose, footer, children }: {
  readonly title: string;
  readonly icon?: IconName;
  readonly tone?: DialogTone;
  readonly onClose?: () => void;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(box, true, onClose);

  useEffect(() => {
    document.documentElement.classList.add('dialog-open');

    return () => document.documentElement.classList.remove('dialog-open');
  }, []);

  return createPortal(
    <div
      className="backdrop"
      onClick={event => {
        if (event.target === event.currentTarget)
          onClose?.();
      }}
    >
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="d-body">
          {icon === undefined ? null : <span className={`icon-circle ${tone === 'neutral' ? '' : tone}`.trim()}><Icon name={icon} /></span>}
          <h2 id={titleId} className="d-title">{title}</h2>
          {children}
        </div>
        {footer === undefined ? null : <div className="d-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};
