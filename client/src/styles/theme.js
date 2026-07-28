import { createTheme, alpha } from '@mui/material/styles';

const STORAGE_KEY = 'uc-ats-theme-mode-v1';

export const themeTokens = {
  light: {
    primary: {
      main: '#042742',
      light: '#e6f0f8',
      dark: '#031d2e',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#075985',
      light: '#e0f2fe',
      dark: '#0c4a6e',
      contrastText: '#ffffff',
    },
    background: {
      default: '#ffffff',
      paper: '#ffffff',
      elevated: '#f8fafc',
    },
    text: {
      primary: '#042742',
      secondary: '#64748b',
      tertiary: '#6b7280',
      muted: '#9ca3af',
      inverse: '#ffffff',
    },
    divider: '#e5e7eb',
    border: {
      light: '#e5e7eb',
      medium: '#d1d5db',
      focus: '#0C74C1',
    },
    action: {
      hover: 'rgba(4, 39, 66, 0.04)',
      selected: 'rgba(4, 39, 66, 0.08)',
      focus: 'rgba(12, 116, 193, 0.12)',
      disabledBackground: 'rgba(4, 39, 66, 0.12)',
    },
    error: { main: '#b91c1c', light: '#fee2e2', dark: '#991b1b', contrastText: '#ffffff' },
    success: { main: '#047857', light: '#dcfce7', dark: '#166534', contrastText: '#ffffff' },
    warning: { main: '#d97706', light: '#fef3c7', dark: '#92400e', contrastText: '#0b1220' },
    info: { main: '#1d4ed8', light: '#eff6ff', dark: '#1e3a8a', contrastText: '#ffffff' },
    grey: {
      50: '#f8fafc',
      100: '#f1f5f9',
      200: '#e2e8f0',
      300: '#cbd5e1',
      400: '#94a3b8',
      500: '#64748b',
      600: '#475569',
      700: '#334155',
      800: '#1e293b',
      900: '#0f172a',
    },
    status: {
      successBg: '#dcfce7',
      successText: '#166534',
      successBorder: '#10b981',
      errorBg: '#fee2e2',
      errorText: '#991b1b',
      errorBorder: '#ef4444',
      warningBg: '#fef3c7',
      warningText: '#92400e',
      warningBorder: '#f59e0b',
      infoBg: '#EEF2FF',
      infoText: '#4F46E5',
      infoBorder: '#6366f1',
    },
    chart: ['#0C74C1', '#042742', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316'],
  },
  dark: {
    primary: {
      main: '#60a5fa',
      light: '#93c5fd',
      dark: '#2563eb',
      contrastText: '#0b1220',
    },
    secondary: {
      main: '#38bdf8',
      light: '#7dd3fc',
      dark: '#0ea5e9',
      contrastText: '#0b1220',
    },
    background: {
      default: '#0b1220',
      paper: '#0f172a',
      elevated: '#1e293b',
    },
    text: {
      primary: '#f8fafc',
      secondary: '#94a3b8',
      tertiary: '#cbd5e1',
      muted: '#64748b',
      inverse: '#0b1220',
    },
    divider: '#1e293b',
    border: {
      light: '#1e293b',
      medium: '#334155',
      focus: '#38bdf8',
    },
    action: {
      hover: 'rgba(148, 163, 184, 0.08)',
      selected: 'rgba(148, 163, 184, 0.16)',
      focus: 'rgba(56, 189, 248, 0.18)',
      disabledBackground: 'rgba(148, 163, 184, 0.15)',
    },
    error: { main: '#f87171', light: '#450a0a', dark: '#fca5a5', contrastText: '#0b1220' },
    success: { main: '#34d399', light: '#064e3b', dark: '#6ee7b7', contrastText: '#0b1220' },
    warning: { main: '#fbbf24', light: '#451a03', dark: '#fcd34d', contrastText: '#0b1220' },
    info: { main: '#60a5fa', light: '#1e3a8a', dark: '#93c5fd', contrastText: '#0b1220' },
    grey: {
      50: '#020617',
      100: '#0b1220',
      200: '#1e293b',
      300: '#334155',
      400: '#475569',
      500: '#64748b',
      600: '#94a3b8',
      700: '#cbd5e1',
      800: '#e2e8f0',
      900: '#f8fafc',
    },
    status: {
      successBg: '#064e3b',
      successText: '#6ee7b7',
      successBorder: '#10b981',
      errorBg: '#450a0a',
      errorText: '#fca5a5',
      errorBorder: '#ef4444',
      warningBg: '#451a03',
      warningText: '#fcd34d',
      warningBorder: '#f59e0b',
      infoBg: '#1e3a8a',
      infoText: '#93c5fd',
      infoBorder: '#3b82f6',
    },
    chart: ['#38bdf8', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb923c'],
  },
};

export function createAppTheme(mode = 'light') {
  const tokens = themeTokens[mode] || themeTokens.light;

  return createTheme({
    palette: {
      mode,
      primary: tokens.primary,
      secondary: tokens.secondary,
      background: tokens.background,
      text: tokens.text,
      divider: tokens.divider,
      action: tokens.action,
      error: tokens.error,
      warning: tokens.warning,
      info: tokens.info,
      success: tokens.success,
      grey: tokens.grey,
      custom: tokens,
    },
    typography: {
      fontFamily: 'Montserrat, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif',
      h1: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 700,
        color: tokens.text.primary,
      },
      h2: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 700,
        color: tokens.text.primary,
      },
      h3: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 700,
        color: tokens.text.primary,
      },
      h4: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 700,
        color: tokens.text.primary,
      },
      h5: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 700,
        color: tokens.text.primary,
      },
      h6: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 700,
        color: tokens.text.primary,
      },
      body1: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 300,
      },
      body2: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 300,
      },
      button: {
        fontFamily: 'Montserrat, sans-serif',
        fontWeight: 400,
        textTransform: 'none',
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': {
            colorScheme: mode,
          },
          body: {
            backgroundColor: tokens.background.default,
            color: tokens.text.primary,
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: '0.5rem',
            textTransform: 'none',
            fontWeight: 500,
            padding: '0.5rem 1rem',
            [theme.breakpoints.down('md')]: {
              minHeight: 44,
            },
          }),
          outlined: ({ theme }) => ({
            borderColor: theme.palette.primary.main,
            color: theme.palette.primary.main,
            '&:hover': {
              backgroundColor: alpha(theme.palette.primary.main, 0.04),
              borderColor: theme.palette.primary.main,
            },
          }),
          text: ({ theme }) => ({
            color: theme.palette.primary.main,
            '&:hover': {
              backgroundColor: alpha(theme.palette.primary.main, 0.04),
            },
          }),
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: ({ theme }) => ({
            '& .MuiOutlinedInput-root': {
              borderRadius: '0.5rem',
              fontFamily: 'Montserrat, sans-serif',
              fontWeight: 300,
              '&:hover fieldset': {
                borderColor: theme.palette.text.primary,
              },
              '&.Mui-focused fieldset': {
                borderColor: theme.palette.primary.main,
                borderWidth: '2px',
              },
            },
            '& .MuiFormLabel-root': {
              fontFamily: 'Montserrat, sans-serif',
              fontWeight: 300,
              color: theme.palette.text.secondary,
              '&.Mui-focused': {
                color: theme.palette.primary.main,
              },
            },
          }),
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: '0.5rem',
            boxShadow:
              theme.palette.mode === 'dark'
                ? '0 1px 3px rgba(0, 0, 0, 0.3)'
                : '0 1px 3px rgba(0, 0, 0, 0.1)',
          }),
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: '0.375rem',
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 400,
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          head: ({ theme }) => ({
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 700,
            color: theme.palette.text.primary,
            backgroundColor: theme.palette.background.elevated,
          }),
          body: {
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 300,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: ({ theme, ownerState }) => ({
            [theme.breakpoints.down('md')]: {
              ...(ownerState?.size !== 'small' && {
                minWidth: 44,
                minHeight: 44,
              }),
            },
          }),
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: '0.5rem',
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
            color: theme.palette.text.primary,
          }),
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
            color: theme.palette.text.primary,
          }),
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
          }),
        },
      },
    },
    shape: {
      borderRadius: 8,
    },
  });
}

export const STORAGE_VERSION_KEY = STORAGE_KEY;
