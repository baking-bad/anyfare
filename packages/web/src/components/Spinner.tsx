/** A 16 px ring that spins once a second. It takes the text color. `label` is what a screen reader hears. */
export const Spinner = ({ label }: { readonly label?: string }) => (
  label === undefined
    ? <span className="spinner" aria-hidden="true" />
    : <span className="spinner" role="status" aria-label={label} />
);
