import { styleText } from 'node:util';

type StyleStream = NonNullable<Parameters<typeof styleText>[2]>['stream'];

/** Styles and line shapes for one output stream. Colors turn off when it is not a terminal or NO_COLOR is set. */
export function createStyle(stream: StyleStream) {
  const paint = (format: Parameters<typeof styleText>[0]) => (text: string) =>
    styleText(format, text, { stream });

  const styles = {
    title: paint('bold'),
    step: paint('cyan'),
    label: paint('dim'),
    value: paint('bold'),
    money: paint(['bold', 'green']),
    ok: paint(['bold', 'green']),
    warn: paint('yellow'),
    link: paint('underline'),
    bar: paint('cyan'),
    error: paint(['bold', 'red']),
  };

  return {
    ...styles,
    /** A step in progress. */
    step: (text: string): string => `${styles.step('▸')} ${text}`,
    /** The one result line. */
    done: (text: string): string => `${styles.ok('✔')} ${text}`,
    /** A failure, for stderr. */
    fail: (text: string): string => `${styles.error('✘')} ${text}`,
    /** A labeled value. Pass the width to line up the labels of one block. */
    field: (label: string, value: string, width = 0): string =>
      `  ${styles.label(label.padEnd(width))}  ${value}`,
    /** The plain-name styles, for use next to the line helpers. */
    styles,
  };
}

export type Style = ReturnType<typeof createStyle>;
