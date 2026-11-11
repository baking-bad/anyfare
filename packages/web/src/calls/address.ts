/**
 * A buyer's address for a table cell: short enough to read, whole when it is already short. A long one
 * keeps its start and its end, with "…" in the middle, such as `0x1234abcd…9f3e21`.
 */
export const shortAddress = (address: string, max = 18): string => {
  if (address.length <= max)
    return address;
  const tail = Math.floor((max - 1) / 3);
  const head = max - 1 - tail;

  return `${address.slice(0, head)}…${address.slice(address.length - tail)}`;
};
