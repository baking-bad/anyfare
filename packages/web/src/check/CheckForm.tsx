'use client';

import { useRouter } from 'next/navigation';
import { useTransition, type FormEvent } from 'react';

import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { checkAddress, checkingLine } from './content';

/**
 * The link field with "Check again". A plain `GET` form, so it works without scripts. With scripts it moves
 * to the check through the router and says the check is running: a check can take several seconds. The
 * field keeps the link as typed, and the query string of the link is never changed.
 */
export const CheckForm = ({ value, label }: { readonly value: string; readonly label: string }) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    const typed = new FormData(event.currentTarget).get('url');
    event.preventDefault();
    startTransition(() => router.push(checkAddress({ url: typeof typed === 'string' ? typed.trim() : '', tab: 'overview', period: '30d', page: 1 })));
  };

  return (
    <form action="/check" method="get" className="stack" onSubmit={submit} aria-busy={pending}>
      <div className="check-box check-field">
        <span className="lead-icon"><Icon name="link" /></span>
        <input key={value} name="url" defaultValue={value} autoComplete="off" spellCheck={false} aria-label="A paid API link" placeholder="Paste a paid API link" />
        <Button size="lg" type="submit" loading={pending}>{label}</Button>
      </div>
      <p className="small muted check-running" role="status">{pending ? checkingLine : ''}</p>
    </form>
  );
};
