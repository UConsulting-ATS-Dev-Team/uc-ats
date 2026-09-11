import React, { useEffect, useState } from 'react';
import { Chip } from '@mui/material';
import { LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline';
import { useExecUnlock } from '../context/ExecUnlockContext';

const minutesLeft = (expiresAt) =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60000));

// Pinned to the corner of every page while executive access is open, so nobody
// forgets they are looking at sealed records - and can close it in one click.
export default function ExecAccessIndicator() {
  const { unlocked, expiresAt, lock } = useExecUnlock();
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!unlocked) return undefined;
    const timer = setInterval(() => rerender((n) => n + 1), 30 * 1000);
    return () => clearInterval(timer);
  }, [unlocked]);

  if (!unlocked) return null;

  return (
    <Chip
      role="status"
      color="warning"
      icon={<LockOpenIcon style={{ width: 16, height: 16 }} aria-hidden="true" />}
      label={`Executive access open · ${minutesLeft(expiresAt)}m left`}
      onDelete={lock}
      deleteIcon={<LockClosedIcon style={{ width: 16, height: 16 }} aria-label="Lock now" />}
      sx={{
        position: 'fixed',
        left: 16,
        bottom: 16,
        zIndex: (theme) => theme.zIndex.snackbar,
        boxShadow: 3,
        fontWeight: 600
      }}
    />
  );
}
