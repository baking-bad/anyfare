import type { ReactNode } from 'react';

const token = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** The text of a value as pretty JSON, two spaces. */
export const jsonText = (value: unknown): string => JSON.stringify(value, null, 2) ?? 'null';

/** Pretty JSON as spans for `CodeBlock`: keys `k`, strings `s`, numbers `n`, true, false and null `b`. */
export const highlightJson = (text: string): ReactNode[] => {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(token)) {
    const at = match.index;
    if (at > last)
      parts.push(text.slice(last, at));
    const [whole, string, colon, literal] = match;
    if (string !== undefined && colon !== undefined)
      parts.push(<span key={at} className="k">{string}</span>, <span key={`${at}:`} className="p">{colon}</span>);
    else if (string !== undefined)
      parts.push(<span key={at} className="s">{string}</span>);
    else
      parts.push(<span key={at} className={literal !== undefined ? 'b' : 'n'}>{whole}</span>);
    last = at + whole.length;
  }
  if (last < text.length)
    parts.push(text.slice(last));

  return parts;
};
