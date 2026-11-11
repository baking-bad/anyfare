// The `curl` commands in a text: a line that starts with `curl `, and the lines that follow while one ends in a backslash.

export const curlCommands = (text: string): string[] => {
  const lines = text.split('\n');
  const found: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.startsWith('curl '))
      continue;
    const command = [lines[index]!];
    while (command[command.length - 1]!.endsWith(' \\') && index + 1 < lines.length) {
      index += 1;
      command.push(lines[index]!);
    }
    found.push(command.join('\n'));
  }

  return found;
};

const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': '\'', '&#39;': '\'' };

/** A page's text: its tags removed and its entities read. Line breaks of a block stay. */
export const textOfHtml = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, entity => entities[entity]!);

// Running the commands of a text as an agent would, with no shell. A text's `sh` blocks hold only a few kinds of line:
// `umask 077`, `NAME=` and a jq read of a file, and a `curl` command that may end in `> file`. Each is read here
// and done in code: the `curl` command runs as the real `curl` program, with its words as arguments.

export type ShellStep =
  | { readonly kind: 'umask'; readonly mask: number }
  | { readonly kind: 'assign'; readonly name: string; readonly field: string; readonly file: string }
  | { readonly kind: 'curl'; readonly words: readonly Word[]; readonly redirect?: string };

// A word of a command: the parts of it that are quoted with `'` are literal, the others read `$NAME`
export type Word = readonly { text: string; readonly literal: boolean }[];

/** What a text's fenced `sh` blocks hold, joined with their continued lines, in order. */
export const shellLines = (text: string): string[] => {
  const lines: string[] = [];
  for (const block of text.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
    let joined = '';
    for (const line of block[1]!.split('\n')) {
      if (line.endsWith(' \\')) {
        joined += `${line.slice(0, -2)} `;
        continue;
      }
      lines.push(`${joined}${line}`.trim());
      joined = '';
    }
  }

  return lines;
};

const tokenize = (line: string): Word[] => {
  const words: { text: string; literal: boolean }[][] = [];
  let word: { text: string; literal: boolean }[] | undefined;
  const add = (char: string, literal: boolean): void => {
    word ??= [];
    const last = word[word.length - 1];
    if (last !== undefined && last.literal === literal)
      last.text += char;
    else
      word.push({ text: char, literal });
  };
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === ' ') {
      if (word !== undefined)
        words.push(word);
      word = undefined;
    }
    else if (char === '\'' || char === '"') {
      const end = line.indexOf(char, index + 1);
      if (end === -1)
        throw new Error(`An open quote in: ${line}`);
      add('', char === '\'');
      for (const inner of line.slice(index + 1, end))
        add(inner, char === '\'');
      index = end;
    }
    else {
      add(char, false);
    }
    index += 1;
  }
  if (word !== undefined)
    words.push(word);

  return words;
};

/** The steps of a text, in order. A line of another kind is an error: an agent could not run it from the text alone. */
export const shellSteps = (text: string): ShellStep[] => shellLines(text).filter(line => line !== '').map((line): ShellStep => {
  const umask = /^umask ([0-7]{3})$/.exec(line);
  if (umask !== null)
    return { kind: 'umask', mask: parseInt(umask[1]!, 8) };
  const assign = /^([A-Z_]+)=\$\(jq -r \.(\w+) ([\w.-]+)\)$/.exec(line);
  if (assign !== null)
    return { kind: 'assign', name: assign[1]!, field: assign[2]!, file: assign[3]! };
  if (line.startsWith('curl ')) {
    const redirect = /^(.*) > ([\w.-]+)$/.exec(line);
    const words = tokenize(redirect === null ? line : redirect[1]!).slice(1);

    return { kind: 'curl', words, ...redirect === null ? {} : { redirect: redirect[2]! } };
  }
  throw new Error(`A line no agent can run from the text: ${line}`);
});

/** A word with its variables read. A variable with no value is an error. */
export const expandWord = (word: Word, variables: Readonly<Record<string, string>>): string => word.map(part => part.literal
  ? part.text
  : part.text.replace(/\$([A-Z_]+)/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined)
      throw new Error(`The text uses $${name} and says nowhere what it is`);

    return value;
  })).join('');
