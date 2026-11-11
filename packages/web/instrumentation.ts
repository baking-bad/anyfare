// Runs once when the Next.js server starts: the website's startup line. Node.js only.
export const register = async (): Promise<void> => {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs')
    return;

  const { logStartup } = await import('./src/startup');
  logStartup();
};
