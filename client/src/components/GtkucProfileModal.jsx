import React, { useEffect, useState } from 'react';
import api from '../utils/api';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  TextField,
  Autocomplete,
  Chip,
  Alert,
  Avatar,
  Stack,
  FormControlLabel,
  Switch,
  CircularProgress,
} from '@mui/material';

// Confirm/update the candidate-facing GTKUC profile. Rendered as a hard gate on
// the member's first timeslot of a cycle (required=true, no dismiss) and as an
// editable dialog from the portal at any time.
export default function GtkucProfileModal({ open, state, required = false, onClose, onSaved }) {
  const [industries, setIndustries] = useState([]);
  const [interests, setInterests] = useState([]);
  const [relevance, setRelevance] = useState('');
  const [candidateVisible, setCandidateVisible] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setIndustries(state?.profile?.industries || []);
    setInterests(state?.profile?.interests || []);
    setRelevance(state?.profile?.relevance || '');
    setCandidateVisible(state?.profile?.candidateVisible ?? true);
    setError('');
  }, [open, state]);

  const taxonomy = state?.taxonomy;
  const relevanceMaxLength = taxonomy?.relevanceMaxLength || 500;
  const reviewStatus = state?.profile?.relevanceReviewStatus;
  const reviewNote = state?.profile?.relevanceReviewNote;
  const blurbLive = Boolean(state?.profile?.relevanceVisibleToCandidates);
  // The blurb is free text, so candidates only see it after an admin approves it.
  const blurbStatus = !state?.profile?.relevance
    ? null
    : reviewStatus === 'APPROVED' && blurbLive
      ? { severity: 'success', text: 'Your blurb is approved and visible to candidates.' }
      : reviewStatus === 'REJECTED'
        ? {
            severity: 'warning',
            text: `An admin asked for changes to your blurb, so candidates do not see it${
              reviewNote ? `: ${reviewNote}` : '.'
            }`
          }
        : {
            severity: 'info',
            text: blurbLive
              ? 'Candidates still see your previously approved blurb while an admin reviews this edit.'
              : 'Your blurb is waiting on admin review. Candidates see your industries and interests until it is approved.'
          };
  const canSubmit = industries.length > 0 && interests.length > 0 && relevance.trim().length > 0;

  const handleSave = async () => {
    try {
      setSaving(true);
      setError('');
      const updated = await api.put('/member/gtkuc-profile', {
        industries,
        interests,
        relevance,
        candidateVisible,
      });
      onSaved?.(updated);
    } catch (e) {
      setError(e.message || 'Failed to save your Get to Know UC profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={required ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={required}
    >
      <DialogTitle sx={{ fontWeight: 600 }}>
        {required ? 'Confirm your Get to Know UC profile' : 'Edit your Get to Know UC profile'}
      </DialogTitle>
      <DialogContent dividers>
        {required && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Candidates see this profile when they pick a timeslot with you. Confirm it once per
            recruiting cycle{state?.activeCycle ? ` (${state.activeCycle.name})` : ''} before opening
            timeslots.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {blurbStatus && (
          <Alert severity={blurbStatus.severity} sx={{ mb: 2 }}>
            {blurbStatus.text}
          </Alert>
        )}

        <Stack spacing={2.5}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Avatar src={state?.profileImage || undefined} sx={{ width: 56, height: 56 }} />
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Profile picture
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {state?.profileImage
                  ? 'Update it from your Profile page if it is out of date.'
                  : 'Add a photo on your Profile page — it is required before you can open timeslots.'}
              </Typography>
            </Box>
          </Box>

          <Autocomplete
            multiple
            options={taxonomy?.industries || []}
            value={industries}
            onChange={(_, value) => setIndustries(value.slice(0, taxonomy?.maxIndustries || 5))}
            renderTags={(value, getTagProps) =>
              value.map((option, index) => (
                <Chip label={option} size="small" {...getTagProps({ index })} key={option} />
              ))
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Industries"
                placeholder="Select industries"
                helperText={`Industries only — candidates never see company names. Up to ${
                  taxonomy?.maxIndustries || 5
                }.`}
              />
            )}
          />

          <Autocomplete
            multiple
            options={taxonomy?.interests || []}
            value={interests}
            onChange={(_, value) => setInterests(value.slice(0, taxonomy?.maxInterests || 8))}
            renderTags={(value, getTagProps) =>
              value.map((option, index) => (
                <Chip label={option} size="small" {...getTagProps({ index })} key={option} />
              ))
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Interests"
                placeholder="Select interests"
                helperText={`Up to ${taxonomy?.maxInterests || 8}.`}
              />
            )}
          />

          <TextField
            label="Why candidates should chat with you"
            value={relevance}
            onChange={(e) => setRelevance(e.target.value.slice(0, relevanceMaxLength))}
            multiline
            minRows={3}
            fullWidth
            helperText={`${relevance.length}/${relevanceMaxLength} — reviewed by an admin before candidates see it. No company names.`}
          />

          <FormControlLabel
            control={
              <Switch
                checked={candidateVisible}
                onChange={(e) => setCandidateVisible(e.target.checked)}
              />
            }
            label="Show this profile to candidates"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        {!required && (
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!canSubmit || saving}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {required ? 'Confirm profile' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
