import { checkMethods, type CheckMethod } from './content';

/**
 * The method the check probes the link with, before the link field in the same box. A plain select of the
 * `GET` form, so it works without scripts. `key` makes it follow the address when the method changes.
 */
export const MethodSelect = ({ value }: { readonly value: CheckMethod }) => (
  <select key={value} className="method-select" name="method" defaultValue={value} aria-label="HTTP method">
    {checkMethods.map(method => <option key={method} value={method}>{method}</option>)}
  </select>
);
