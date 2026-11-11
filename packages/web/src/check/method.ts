// The HTTP methods of the check. Kept apart from the page's words so the service pages can read them too.

/** The HTTP methods the check can probe with: a GET, or a POST for an API that asks for payment only there. The probe has no body. */
export const checkMethods = ['GET', 'POST'] as const;

export type CheckMethod = (typeof checkMethods)[number];

export const defaultMethod: CheckMethod = 'GET';

/**
 * The header a POST check must carry. Without it the pay host answers 400, so a plain link or a form can't make
 * Anyfare send a POST to someone else's API. Only a read that means to check sends it.
 */
export const checkHeader: Readonly<Record<string, string>> = { 'X-Anyfare-Check': '1' };

/** A method of the five, written in upper case; anything else is nothing. */
export const knownMethod = (value: string | null | undefined): CheckMethod | undefined =>
  checkMethods.find(method => method === value);

/** The method a query value stands for: one of the five in upper case, and `GET` for anything else. */
export const parseMethod = (value: string | null | undefined): CheckMethod => knownMethod(value) ?? defaultMethod;
