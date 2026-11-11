// What the agent files print about answers, read back from their text, and the comparison with a real answer.

export interface PrintedAnswer {
  // The endpoint's heading as llms-full.txt writes it: `GET /v1/keys (API host)`
  readonly heading: string;
  readonly json: unknown;
}

// The endpoint sections of llms-full.txt: each starts with `### `
const sections = (text: string): { readonly heading: string; readonly body: string }[] =>
  text.split('\n### ').slice(1).map(section => {
    const [heading, ...rest] = section.split('\n');

    return { heading: heading!, body: rest.join('\n') };
  }).filter(section => /^(?:GET|POST|PATCH|DELETE|ANY) \S+ \((?:API|pay) host\)$/.test(section.heading));

/** Every JSON answer llms-full.txt prints after "Answer, <status>:". */
export const printedAnswers = (text: string): PrintedAnswer[] => sections(text).flatMap(({ heading, body }) => {
  const found = /Answer, \d{3}:\n\n```json\n([\s\S]*?)\n```/.exec(body);

  return found === null ? [] : [{ heading, json: JSON.parse(found[1]!) as unknown }];
});

/** The error list each endpoint section prints, as `status code` items. */
export const printedErrorList = (text: string): [string, string[]][] => sections(text).map(({ heading, body }) => {
  const found = /\nErrors: (.*)\.$/m.exec(`\n${body}`);

  return [heading, found === null ? [] : found[1]!.split(', ')];
});

/** The 402 as "The 402" prints it: the names of its headers and its JSON body. */
export const printedChallenge = (text: string): { readonly headers: string[]; readonly body: unknown } => {
  const section = text.slice(text.indexOf('\n## The 402\n'), text.indexOf('\n### Pay with a payment key'));
  const headers = /```\n(HTTP\/1\.1 402[\s\S]*?)\n```/.exec(section)![1]!;
  const body = /```json\n([\s\S]*?)\n```/.exec(section)![1]!;

  return {
    headers: headers.split('\n').slice(1).map(line => /^([\w-]+):/.exec(line)?.[1]?.toLowerCase()).filter((name): name is string => name !== undefined),
    body: JSON.parse(body) as unknown,
  };
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The places where a printed value has a field the real answer does not. An empty real list holds nothing to compare. */
export const missingFields = (printed: unknown, real: unknown, path = ''): string[] => {
  if (isObject(printed)) {
    if (!isObject(real))
      return [`${path || '(answer)'}: printed as an object, real is ${real === null ? 'null' : Array.isArray(real) ? 'a list' : typeof real}`];

    return Object.entries(printed).flatMap(([name, value]) => name in real ? missingFields(value, real[name], `${path}.${name}`) : [`${path}.${name}`]);
  }
  if (Array.isArray(printed)) {
    if (!Array.isArray(real))
      return [`${path}: printed as a list, real is ${real === null ? 'null' : typeof real}`];

    return printed.length === 0 || real.length === 0 ? [] : missingFields(printed[0], real[0], `${path}[0]`);
  }

  return [];
};
