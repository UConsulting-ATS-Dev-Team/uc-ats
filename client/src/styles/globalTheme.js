import { createTheme } from '@mui/material/styles';

// Global Material-UI theme for the entire app
const globalTheme = createTheme({
  palette: {
    primary: { 
      main: '#042742',      // Official UConsulting primary color
      light: '#063557',     // Slightly lighter for hover
      dark: '#031d2e',      // Darker for pressed state
    },
    secondary: { 
      main: '#0C74C1',      // Official UConsulting accent color
      light: '#5ba3e8',     
      dark: '#084a7d',      
    },
    background: { 
      default: '#ffffff',   // Clean white background
      paper: '#ffffff',     // White cards
    },
    text: {
      primary: '#042742',   // Official brand color for text
      secondary: '#64748b', // Gray text
    },
    divider: '#e5e7eb',     // Light divider color
    action: {
      hover: 'rgba(4, 39, 66, 0.04)',
      selected: 'rgba(4, 39, 66, 0.08)',
    },
  },
  typography: {
    fontFamily: 'Montserrat, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif',
    h1: { 
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 700,  // Montserrat Bold
      color: '#042742',
    },
    h2: { 
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 700,  // Montserrat Bold
      color: '#042742',
    },
    h3: { 
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 700,  // Montserrat Bold
      color: '#042742',
    },
    h4: { 
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 700,  // Montserrat Bold
      color: '#042742',
    },
    h5: { 
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 700,  // Montserrat Bold
      color: '#042742',
    },
    h6: { 
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 700,  // Montserrat Bold
      color: '#042742',
    },
    body1: {
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 300,  // Montserrat Light for body text
    },
    body2: {
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 300,  // Montserrat Light for body text
    },
    button: {
      fontFamily: 'Montserrat, sans-serif',
      fontWeight: 400,  // Montserrat Regular for buttons
      textTransform: 'none', // Don't uppercase button text
    },
  },
  components: {
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
        contained: {
          backgroundColor: '#042742',
          color: '#ffffff',
          '&:hover': {
            backgroundColor: '#063557',
          },
        },
        outlined: {
          borderColor: '#042742',
          color: '#042742',
          '&:hover': {
            backgroundColor: 'rgba(4, 39, 66, 0.04)',
            borderColor: '#042742',
          },
        },
        text: {
          color: '#042742',
          '&:hover': {
            backgroundColor: 'rgba(4, 39, 66, 0.04)',
          },
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: '0.5rem',
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 300,
            '&:hover fieldset': { 
              borderColor: '#042742',
            },
            '&.Mui-focused fieldset': { 
              borderColor: '#042742', 
              borderWidth: '2px',
            },
          },
          '& .MuiFormLabel-root': {
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 300,
            color: '#64748b',
            '&.Mui-focused': {
              color: '#042742',
            },
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: '0.5rem',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
        },
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
        head: {
          fontFamily: 'Montserrat, sans-serif',
          fontWeight: 700,
          color: '#042742',
          backgroundColor: '#f8fafc',
        },
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
  },
  shape: {
    borderRadius: 8,
  },
});

export default globalTheme; 