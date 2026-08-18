export type Theme = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'outreachr.theme';

export function getStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'system' ? stored : 'light';
  } catch {
    return 'light';
  }
}

export function setStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable or restricted in some environments; theme still applies for the session.
  }
}
