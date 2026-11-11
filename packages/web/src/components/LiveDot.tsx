/** The green "live" dot with a slow ping ring. `paused` turns it gray and still. */
export const LiveDot = ({ paused = false }: { readonly paused?: boolean }) => <span className={paused ? 'live-dot paused' : 'live-dot'} aria-hidden="true" />;
