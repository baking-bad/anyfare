// The HTTP methods of the check. Kept apart from the page's words so the service pages can read them too.

/** The methods the check can send to the API. */
export const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type HttpMethod = (typeof httpMethods)[number];

/** What the visitor picks: one method, or `ANY`, which leaves the choice to the check (it tries GET, then POST). */
export const checkMethods = ['ANY', ...httpMethods] as const;

export type CheckMethod = (typeof checkMethods)[number];

/** "Any method": the address carries no `method`, and the check sends none. */
export const defaultMethod: CheckMethod = 'ANY';

/**
 * The header a check carries. The pay host needs it for every method but GET, and for the POST try of a check with no
 * method, so a plain link or a form can't make Anyfare send a POST to someone else's API. The website sends it on every check.
 */
export const checkHeader: Readonly<Record<string, string>> = { 'X-Anyfare-Check': '1' };

/** One of the five methods, written in upper case; anything else, `ANY` included, is nothing. */
export const knownMethod = (value: string | null | undefined): HttpMethod | undefined =>
  httpMethods.find(method => method === value);

/** The method a query value stands for: one of the five in upper case, and "any" for anything else. */
export const parseMethod = (value: string | null | undefined): CheckMethod => knownMethod(value) ?? defaultMethod;
