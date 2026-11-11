// The theme choice: Light, Dark or System. The choice is kept in localStorage under `anyfare-theme`
// (nothing is kept for System), and the class `light` or `dark` is on <html>. The inline script in the
// layout sets the class before the first paint.

export type ThemeChoice = 'light' | 'dark' | 'system';

export const themeKey = 'anyfare-theme';

export const readThemeChoice = (): ThemeChoice => {
  try {
    const stored = localStorage.getItem(themeKey);

    return stored === 'light' || stored === 'dark' ? stored : 'system';
  }
  catch {
    return 'system';
  }
};

const systemTheme = (): 'light' | 'dark' => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

/** Puts the class for the choice on <html>, without saving anything. */
export const showTheme = (choice: ThemeChoice): void => {
  const theme = choice === 'system' ? systemTheme() : choice;
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(theme);
};

/** Saves the choice and shows it. System removes the saved choice. */
export const setThemeChoice = (choice: ThemeChoice): void => {
  try {
    if (choice === 'system')
      localStorage.removeItem(themeKey);
    else
      localStorage.setItem(themeKey, choice);
  }
  catch {
    // Storage is blocked: the choice holds for this page only
  }
  showTheme(choice);
};
