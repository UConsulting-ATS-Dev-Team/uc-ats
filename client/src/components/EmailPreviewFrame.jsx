import React from 'react';
import { Alert, Box, LinearProgress, Stack, Typography } from '@mui/material';

/**
 * A rendered email beside an editor. Takes the `useDraftPreview` state.
 *
 * Keeps showing the last good render while the next one loads, with a thin
 * progress bar, so the frame does not flash blank on every keystroke.
 */
export default function EmailPreviewFrame({ preview, height = { xs: 420, md: '60vh' } }) {
  const { loading, error, data } = preview;

  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Box sx={{ height: 4 }}>{loading && <LinearProgress />}</Box>
      {error && <Alert severity="warning">{error}</Alert>}
      {data && (
        <>
          <Typography variant="caption" color="text.secondary" noWrap title={data.subject}>
            {data.label} · {data.subject}
          </Typography>
          <Box
            component="iframe"
            title={`${data.label} draft preview`}
            srcDoc={data.html}
            sandbox=""
            sx={{
              width: '100%',
              height,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: '#ffffff',
            }}
          />
        </>
      )}
    </Stack>
  );
}
