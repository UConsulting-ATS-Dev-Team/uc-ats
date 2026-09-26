import React, { useEffect, useState } from 'react';
import { Alert, Box, Chip, CircularProgress, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import { CheckCircle as DoneIcon, RadioButtonUnchecked as OpenIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

const formatPoints = (value) => String(Number(value));

/**
 * A member's own accountability points for the current cycle, and what is left
 * to do if they are not at the target yet. Each type counts once.
 */
export default function AccountabilityPointsCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiClient
      .get('/member/accountability')
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load your points'));
  }, []);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) {
    return (
      <Paper sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress size={24} />
      </Paper>
    );
  }
  if (!data.standing) return null;

  const { points, targetPoints, remainingPoints, met, types } = data.standing;
  const open = types.filter((t) => !t.done && t.points > 0);
  const done = types.filter((t) => t.done);
  const progress = Math.min(100, (points / targetPoints) * 100);

  return (
    <Paper sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" mb={1}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Accountability points
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {data.cycle.name}
        </Typography>
      </Stack>

      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          {formatPoints(points)}
        </Typography>
        <Typography color="text.secondary">of {formatPoints(targetPoints)}</Typography>
        <Box flexGrow={1} />
        {met ? (
          <Chip label="Target met" color="success" size="small" />
        ) : (
          <Chip label={`${formatPoints(remainingPoints)} to go`} color="warning" size="small" />
        )}
      </Stack>
      <LinearProgress
        variant="determinate"
        value={progress}
        color={met ? 'success' : 'primary'}
        sx={{ height: 8, borderRadius: 4, my: 2 }}
      />

      {!met && open.length > 0 && (
        <Typography variant="subtitle2" gutterBottom>
          Ways to get there (each counts once)
        </Typography>
      )}
      <Stack spacing={1}>
        {[...(met ? [] : open), ...done].map((type) => (
          <Stack key={type.key} direction="row" spacing={1.5} alignItems="flex-start">
            {type.done ? (
              <DoneIcon fontSize="small" color="success" sx={{ mt: 0.25 }} />
            ) : (
              <OpenIcon fontSize="small" color="disabled" sx={{ mt: 0.25 }} />
            )}
            <Box flexGrow={1}>
              <Typography variant="body2" sx={{ fontWeight: 500 }} color={type.done ? 'text.secondary' : 'text.primary'}>
                {type.label}
              </Typography>
              {!type.done && (
                <Typography variant="caption" color="text.secondary">
                  {type.howTo}
                </Typography>
              )}
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {formatPoints(type.points)} pt
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}
