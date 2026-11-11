'use client';

import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { CopyButton } from '../components/CopyButton';
import { useSettings } from '../components/Settings';
import { changeKey, ConsoleApiError, createKey, type PaymentKey } from './api';
import { Dialog } from './components/Dialog';
import { KeyOnce } from './components/KeyOnce';
import { problemText } from './context';
import { changeBody, emptyKeyForm, formOfKey, formProblems, keyName, newKeyBody, type FormField, type KeyForm } from './keys';

/** What the dialog is for: a new key, or the limits of a key. */
export type KeyDialogMode =
  | { readonly kind: 'new' }
  | { readonly kind: 'limits'; readonly key: PaymentKey };

type Step =
  | { readonly kind: 'form' }
  // The new payment key, shown once: it lives in this state, and in nothing else
  | { readonly kind: 'shown'; readonly paymentKey: string }
  | { readonly kind: 'closed' };

const fields: readonly { readonly name: FormField; readonly label: string; readonly hint: string; readonly optional: boolean }[] = [
  { name: 'label', label: 'Name', hint: 'Which agent holds it. Up to 60 characters.', optional: true },
  { name: 'dailyBudget', label: 'Per day', hint: 'USD, a UTC day', optional: false },
  { name: 'maxPrice', label: 'Per call, at most', hint: 'USD. Empty is no cap.', optional: true },
  { name: 'allowance', label: 'In total', hint: 'USD. Empty is no cap.', optional: true },
  { name: 'expires', label: 'Expires', hint: 'The end of that day, UTC. Empty is never.', optional: true },
];

const lostAnswer = 'The key was made, but its answer didn\'t arrive, so it can\'t be shown. Revoke it in the list and make another.';

/** The API's refusal of a field says which one: its message is shown as it is, as text. */
const refusal = (error: unknown): string => error instanceof ConsoleApiError && error.code === 'invalid_request' ? error.message : problemText(error);

/**
 * The form of a payment key, for a new key and for "Change limits". The fields are checked before they are sent, and
 * the API's own refusal shows under the form. A new key's answer holds the payment key: this component turns into the
 * step that shows it once, holds it in its own state, and clears it when it closes and on `pagehide`. That step does
 * not close on Escape or on a click outside.
 */
export const KeyDialog = ({ mode, onClose, onChanged }: {
  readonly mode: KeyDialogMode;
  readonly onClose: () => void;
  // The list must be read again: a key was made, or its limits were saved. `message` is the toast's line, when there is one
  readonly onChanged: (message?: string) => void;
}) => {
  const { apiUrl } = useSettings();
  const [form, setForm] = useState<KeyForm>(mode.kind === 'new' ? emptyKeyForm : formOfKey(mode.key));
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [sending, setSending] = useState(false);
  const [problems, setProblems] = useState<Partial<Record<FormField, string>>>({});
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const shown = step.kind === 'shown';

  // Cleared at once when the page is left, so a page frozen into the back-forward cache holds no key
  useEffect(() => {
    if (!shown)
      return undefined;
    const drop = (): void => flushSync(() => setStep({ kind: 'closed' }));
    window.addEventListener('pagehide', drop);

    return () => window.removeEventListener('pagehide', drop);
  }, [shown]);

  if (step.kind === 'closed')
    return null;

  const submit = async (): Promise<void> => {
    if (sending)
      return;
    const found = formProblems(form, Date.now());
    setProblems(found);
    setRefused(undefined);
    if (Object.keys(found).length > 0)
      return;
    if (mode.kind === 'limits') {
      const body = changeBody(form, mode.key);
      if (Object.keys(body).length === 0) {
        onClose();

        return;
      }
      setSending(true);
      try {
        await changeKey(apiUrl, mode.key.id, body);
        onChanged('Limits saved');
        onClose();
      }
      catch (error) {
        setRefused(refusal(error));
        setSending(false);
      }

      return;
    }
    setSending(true);
    try {
      const made = await createKey(apiUrl, newKeyBody(form));
      onChanged('Key made');
      setSending(false);
      setStep({ kind: 'shown', paymentKey: made.paymentKey });
    }
    catch (error) {
      // The key was made, but what came back couldn't be read: it exists, and it can't be shown
      if (error instanceof ConsoleApiError && error.status === 200 && error.code === 'unexpected_answer') {
        setRefused(lostAnswer);
        onChanged();
      }
      else {
        setRefused(refusal(error));
      }
      setSending(false);
    }
  };

  if (step.kind === 'shown') {
    const done = (): void => {
      setStep({ kind: 'closed' });
      onClose();
    };

    return (
      <Dialog
        title="Copy the key now"
        icon="key"
        tone="brand"
        footer={(
          <>
            <CopyButton text={step.paymentKey} label="Copy" name="Copy the payment key" withIcon size="md" />
            <Button onClick={done}>I saved it</Button>
          </>
        )}
      >
        <p className="muted small">We show it once. We keep only its hash.</p>
        <KeyOnce value={step.paymentKey} label="Payment key" copy={false} />
        <CodeBlock code={`export ANYFARE_PAYMENT_KEY=${step.paymentKey}`} wrap copyName="Copy the export line" />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={mode.kind === 'new' ? 'New payment key' : `Limits of "${keyName(mode.key)}"`}
      icon="key"
      tone="brand"
      {...sending ? {} : { onClose }}
      footer={(
        <>
          <Button variant="outline" disabled={sending} onClick={onClose}>Cancel</Button>
          <Button loading={sending} onClick={() => void submit()}>{mode.kind === 'new' ? 'Make key' : 'Save'}</Button>
        </>
      )}
    >
      <p className="muted small">Limits are caps. No money moves to the key. The Credits stay on your account.</p>
      <div className="stack key-form">
        {fields.map(field => {
          const id = `key-${field.name}`;
          const problem = problems[field.name];

          return (
            <div key={field.name} className="field">
              <label htmlFor={id}>{field.label}{field.optional ? <span className="muted"> Optional</span> : null}</label>
              <input
                id={id}
                className="input"
                type={field.name === 'expires' ? 'date' : 'text'}
                inputMode={field.name === 'label' || field.name === 'expires' ? undefined : 'decimal'}
                autoComplete="off"
                spellCheck={false}
                placeholder={field.name === 'label' ? 'my agent' : field.optional && field.name !== 'expires' ? 'No cap' : undefined}
                value={form[field.name]}
                aria-invalid={problem === undefined ? undefined : true}
                aria-describedby={`${id}-hint`}
                onChange={event => setForm({ ...form, [field.name]: event.target.value })}
                onKeyDown={event => {
                  if (event.key === 'Enter')
                    void submit();
                }}
              />
              {problem === undefined ? <span id={`${id}-hint`} className="hint">{field.hint}</span> : <span id={`${id}-hint`} className="error" role="alert">{problem}</span>}
            </div>
          );
        })}
        {refused === undefined ? null : <p className="small field-error" role="alert">{refused}</p>}
      </div>
    </Dialog>
  );
};
