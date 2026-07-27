import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ThemeProvider as MuiThemeProvider, CssBaseline } from '@mui/material';
import { createAppTheme, STORAGE_VERSION_KEY } from '../styles/theme';

const ThemeControlContext = createContext({
  mode: 'system',
  resolvedMode: 'light',
  setMode: () => {},
});

export function useThemeControl() {
  return useContext(ThemeControlContext);
}

function getInitialMode() {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(STORAGE_VERSION_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // ignore storage failures
  }
  return 'system';
}

function getSystemDark() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function AppThemeProvider({ children }) {
  const [mode, setModeState] = useState(getInitialMode);
  const [systemDark, setSystemDark] = useState(getSystemDark);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event) => setSystemDark(event.matches);
    if (media.addEventListener) {
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    }
    // Fallback for older environments (including some jsdom versions)
    media.addListener(listener);
    return () => media.removeListener(listener);
  }, []);

  const resolvedMode = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  const setMode = (nextMode) => {
    if (nextMode !== 'light' && nextMode !== 'dark' && nextMode !== 'system') return;
    setModeState(nextMode);
    try {
      window.localStorage.setItem(STORAGE_VERSION_KEY, nextMode);
    } catch {
      // ignore storage failures
    }
  };

  const theme = useMemo(() => createAppTheme(resolvedMode), [resolvedMode]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', resolvedMode);
    document.body.style.backgroundColor = theme.palette.background.default;
  }, [resolvedMode, theme]);

  const value = useMemo(
    () => ({ mode, resolvedMode, setMode, systemDark }),
    [mode, resolvedMode, systemDark]
  );

  return (
    <MuiThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      <ThemeControlContext.Provider value={value}>{children}</ThemeControlContext.Provider>
    </MuiThemeProvider>
  );
}
