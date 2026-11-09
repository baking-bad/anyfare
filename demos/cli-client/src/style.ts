import { styleText } from 'node:util';
import { LABEL_WIDTH } from './tools/read.ts';

/** The width of the result's header and closing line. */
const RULE_WIDTH = 48;
const RESULT_MARK = '━━';

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
    /**
     * The result of a call, set apart from the plan: a bold header with the tool's name, the answer's
     * lines under a left bar (a label and a value from `line` get the value in bold), a closing line,
     * and the proof under its own small header. One blank line before it and one after it. The
     * characters are the same without colors.
     */
    result: (name: string, answer: readonly string[], proof: readonly string[]): string[] => {
      const head = `${RESULT_MARK} Result: ${name} `;
      const bar = styles.bar('│');
      const valued = (text: string): string => {
        const label = text.slice(0, LABEL_WIDTH);
        const value = text.slice(LABEL_WIDTH);
        // A label is padded to its width with at least two spaces; a value starts right after it
        return label.endsWith('  ') && /^\S/.test(value) ? `${label}${styles.value(value)}` : text;
      };
      return [
        '',
        styles.title(head + '━'.repeat(Math.max(3, RULE_WIDTH - head.length))),
        ...answer.map((text) => `  ${bar} ${valued(text)}`.trimEnd()),
        `  ${styles.bar('└')}${styles.bar('─'.repeat(RULE_WIDTH - 3))}`,
        ...(proof.length === 0 ? [] : [`  ${styles.label('Proof')}`, ...proof.map((text) => `    ${text}`)]),
        '',
      ];
    },
    /** The plain-name styles, for use next to the line helpers. */
    styles,
  };
}

export type Style = ReturnType<typeof createStyle>;
