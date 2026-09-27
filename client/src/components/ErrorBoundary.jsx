import React from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';

import { reportError } from '../analytics/errorTracking';

/**
 * The app had no error boundary: a render error anywhere unmounted everything
 * and left a blank page. This catches it, reports it to Site Analytics, and
 * offers a reload.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const firstComponent = (info?.componentStack || '').trim().split('\n')[0]?.trim() || null;
    reportError(error?.message || String(error), { source: 'render', component: firstComponent?.slice(0, 120) || null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh', p: 2 }}>
        <Paper sx={{ p: 4, maxWidth: 480, textAlign: 'center' }}>
          <Typography variant="h5" gutterBottom>
            Something went wrong on this page
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            The error has been reported. Reloading usually fixes it.
          </Typography>
          <Button variant="contained" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </Paper>
      </Box>
    );
  }
}
