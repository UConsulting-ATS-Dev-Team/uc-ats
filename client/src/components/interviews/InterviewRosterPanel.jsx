import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Snackbar, Stack, Typography } from '@mui/material';
import apiClient from '../../utils/api';
import InterviewRosterGallery from './InterviewRosterGallery';
import InterviewSlotSetup from './InterviewSlotSetup';

/**
 * The roster for one interview: fetch, render, and write back.
 *
 * Optimistic on the move - a drag that waits for a round trip feels broken -
 * but the server is the authority, so any non-2xx reverts and refetches rather
 * than leaving the gallery showing something the database does not agree with.
 */
export default function InterviewRosterPanel({ interviewId, interviewType, onRosterChanged }) {
  const [roster, setRoster] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError('');
      setRoster(await apiClient.get(`/admin/interviews/${interviewId}/roster`));
    } catch (e) {
      setError(e.message || 'Failed to load the roster.');
    } finally {
      setLoading(false);
    }
  }, [interviewId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Move a card between columns, showing the result before the server confirms it. */
  const handleMove = async (signup, slot, { force = false } = {}) => {
    const snapshot = roster;
    setBusy(true);
    setRoster((current) => {
      if (!current) return current;
      const slots = current.slots.map((s) => {
        if (s.id === slot.id) {
          return { ...s, signups: [...s.signups, { ...signup, status: 'CONFIRMED' }] };
        }
        return { ...s, signups: s.signups.filter((x) => x.id !== signup.id) };
      });
      return { ...current, slots };
    });

    try {
      const result = await apiClient.post(`/admin/interviews/slot-signups/${signup.id}/move`, {
        toSlotId: slot.id,
        force,
      });
      if (result.promoted > 0) {
        setToast(`Moved. ${result.promoted} candidate${result.promoted === 1 ? '' : 's'} promoted off the waitlist.`);
      }
      await load();
      onRosterChanged?.();
    } catch (e) {
      // Never leave the gallery drifted from the server.
      setRoster(snapshot);
      setError(e.message || 'That move did not go through.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (signup) => {
    const name = `${signup.candidate?.firstName ?? ''} ${signup.candidate?.lastName ?? ''}`.trim();
    if (!window.confirm(`Remove ${name} from this interview? They will be emailed.`)) return;

    setBusy(true);
    try {
      const result = await apiClient.delete(`/admin/interviews/slot-signups/${signup.id}`);
      if (result.promoted > 0) {
        setToast(`Removed. ${result.promoted} candidate${result.promoted === 1 ? '' : 's'} promoted off the waitlist.`);
      }
      await load();
      onRosterChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to remove that candidate.');
    } finally {
      setBusy(false);
    }
  };

  const handlePlace = async (application) => {
    const slots = roster?.slots ?? [];
    if (slots.length === 0) return;
    // Deliberately simple: put them in the first session with room, or the
    // first session at all, and let the admin drag them somewhere better. A
    // picker here would be a third way to choose a slot on a page that already
    // has two.
    const target =
      slots.find(
        (s) =>
          s.candidateCapacity == null ||
          s.signups.filter((x) => x.status === 'CONFIRMED').length < s.candidateCapacity
      ) ?? slots[0];

    setBusy(true);
    try {
      await apiClient.post(`/admin/interviews/${interviewId}/slot-signups`, {
        slotId: target.id,
        applicationId: application.id,
        force: true,
      });
      await load();
      onRosterChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to schedule that candidate.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  const hasSlots = (roster?.slots?.length ?? 0) > 0;

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Always reachable, not just on an empty interview. A cycle that was
          backfilled from the old group config already has slots - historical
          pairings with no capacity - and hiding this behind "no slots yet" left
          an admin with no way to add the sessions candidates actually book. */}
      {(!hasSlots || setupOpen) && (
        <InterviewSlotSetup
          interviewId={interviewId}
          interviewType={interviewType}
          onCreated={() => {
            setSetupOpen(false);
            load();
            onRosterChanged?.();
          }}
        />
      )}

      {hasSlots && (
        <>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1, mt: setupOpen ? 3 : 0 }}>
            <Typography variant="subtitle2" color="text.secondary">
              Drag a candidate between sessions, or use the menu on their card.
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={() => setSetupOpen((open) => !open)} disabled={busy}>
                {setupOpen ? 'Close' : 'Add sessions'}
              </Button>
              <Button size="small" onClick={load} disabled={busy}>
                Refresh
              </Button>
            </Stack>
          </Stack>
          <InterviewRosterGallery
            roster={roster}
            busy={busy}
            onMove={handleMove}
            onRemove={handleRemove}
            onPlace={handlePlace}
          />
        </>
      )}

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={6000}
        onClose={() => setToast('')}
        message={toast}
      />
    </Box>
  );
}
