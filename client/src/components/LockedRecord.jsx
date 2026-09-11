import React from 'react';
import { Box, Button, Chip, Typography } from '@mui/material';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { useExecUnlock } from '../context/ExecUnlockContext';

// Stands in for a sealed recruiting record: a single record the server answered
// with 423, or a list row it returned with `locked: true`.
export default function LockedRecord({ title = 'Sealed record', description }) {
  const { openUnlockDialog } = useExecUnlock();

  return (
    <Box
      role="status"
      sx={{
        border: '1px dashed',
        borderColor: 'divider',
        borderRadius: 2,
        p: 3,
        my: 2,
        textAlign: 'center'
      }}
    >
      <LockClosedIcon
        aria-hidden="true"
        style={{ width: 32, height: 32, display: 'block', margin: '0 auto 8px' }}
      />
      <Typography variant="h6" sx={{ fontWeight: 600 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 2, maxWidth: 460, mx: 'auto' }}>
        {description ||
          'Scores, feedback and application details for this person are sealed. Only the executive committee can view them.'}
      </Typography>
      <Button variant="contained" onClick={openUnlockDialog}>
        Enter executive password
      </Button>
    </Box>
  );
}

export function LockedChip({ size = 'small' }) {
  return (
    <Chip
      size={size}
      variant="outlined"
      icon={<LockClosedIcon style={{ width: 14, height: 14 }} aria-hidden="true" />}
      label="Sealed"
    />
  );
}
