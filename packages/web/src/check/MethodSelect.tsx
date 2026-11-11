import { checkMethods, type CheckMethod } from './content';

/** How a method reads in the menu. */
export const methodLabel = (method: CheckMethod): string => method === 'ANY' ? 'Any method' : method;

/**
 * The method the check asks with, before the link field in the same box. A plain select of the `GET` form, so it
 * works without scripts. "Any method" is the default: the check tries GET, then POST. `key` makes it follow the
 * address when the method changes.
 */
export const MethodSelect = ({ value }: { readonly value: CheckMethod }) => (
  <select key={value} className="method-select" name="method" defaultValue={value} aria-label="HTTP method">
    {checkMethods.map(method => <option key={method} value={method}>{methodLabel(method)}</option>)}
  </select>
);
