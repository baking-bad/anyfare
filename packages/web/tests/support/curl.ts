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
