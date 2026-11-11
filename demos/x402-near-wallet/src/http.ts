// The pieces of HTTP that reads share: the fetch type and the words for a time limit.

export type Fetch = typeof fetch;

/** A time limit in words: "300 ms", "30 seconds". */
export const limitText = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} seconds`);
