import React, { useEffect, useState } from 'react';
import { Alert, Button, Chip, Stack } from '@mui/material';
import { LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { useExecUnlock } from '../context/ExecUnlockContext';

// Says whether a candidate's recruiting record is sealed and, for an admin with
// executive access open, seals or unseals it by hand. New members are sealed
// automatically; this covers everyone else.
export default function RecordSealControl({ candidateId }) {
  const { user } = useAuth();
  const { unlocked, version } = useExecUnlock();
  const [locked, setLocked] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!candidateId) return undefined;
    let cancelled = false;
    apiClient
      .get(`/exec-access/candidates/${candidateId}`)
      .then((result) => {
        if (!cancelled) setLocked(result.locked);
      })
      .catch(() => {
        if (!cancelled) setLocked(null);
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, version]);

  if (!candidateId || locked === null) return null;

  const canToggle = user?.role === 'ADMIN' && unlocked;

  const toggle = async () => {
    const question = locked
      ? 'Unseal this record? Every admin and member will see these scores and this feedback without the executive password.'
      : 'Seal this record? Its scores, feedback and application details will need the executive password.';
    if (!window.confirm(question)) return;

    setSaving(true);
    setError('');
    try {
      const result = await apiClient.post(`/exec-access/candidates/${candidateId}/${locked ? 'unlock' : 'lock'}`, {});
      setLocked(result.locked);
    } catch (err) {
      setError(err.serverMessage || err.message || 'Could not change the seal.');
    } finally {
      setSaving(false);
    }
  };

  if (!locked && !canToggle) return null;

  return (
    <Stack spacing={1} sx={{ my: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        {locked && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            icon={<LockClosedIcon style={{ width: 14, height: 14 }} aria-hidden="true" />}
            label="Sealed record · visible through executive access"
          />
        )}
        {canToggle && (
          <Button
            size="small"
            variant="outlined"
            onClick={toggle}
            disabled={saving}
            startIcon={locked
              ? <LockOpenIcon style={{ width: 16, height: 16 }} aria-hidden="true" />
              : <LockClosedIcon style={{ width: 16, height: 16 }} aria-hidden="true" />}
          >
            {locked ? 'Unseal record' : 'Seal record'}
          </Button>
        )}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
