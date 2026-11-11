// Parts of the routes' Fastify schemas. A response schema also keeps out any field it doesn't name, so each one
// names every field its route sends, in the order the route builds them.

export const string = { type: 'string' } as const;
export const integer = { type: 'integer' } as const;
export const boolean = { type: 'boolean' } as const;
export const time = { type: 'string', format: 'date-time' } as const;
export const nullableString = { type: ['string', 'null'] } as const;
export const nullableTime = { type: ['string', 'null'], format: 'date-time' } as const;
export const usdString = { type: 'string', description: 'USD, as a decimal string' } as const;
export const nullableUsdString = { type: ['string', 'null'], description: 'USD, as a decimal string' } as const;

/** An object of exactly these fields: all of them, or those `required` names. */
export const object = <TProperties extends Record<string, unknown>>(properties: TProperties, required: readonly (keyof TProperties & string)[] = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as const;

export const list = <TItems>(items: TItems) => ({ type: 'array', items }) as const;

/** The path parameters of a route with an `:id`. */
export const idParamsSchema = (description: string) => ({
  type: 'object',
  properties: { id: { type: 'string', description } },
  required: ['id'],
}) as const;
