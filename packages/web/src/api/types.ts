/** The body of a Platform API error answer. */
export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
