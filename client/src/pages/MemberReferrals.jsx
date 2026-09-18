import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import apiClient from '../utils/api';

// Refer someone who has not applied yet.
//
// Referring a person who already has an application happens on their
// application page, where there is a record to attach to. This page is for the
// other case, which used to have nowhere to go: a member vouches for someone
// who has not filled in the form. All we ask for is a name, because a name is
// all a member reliably knows. The referral waits, unattached, until form sync
// sees an application under that name and claims it - within five minutes of
// them applying, not instantly, since sync runs on a cron.
//
// If they never apply, the referral simply stays pending. That is the intended
// end state, not a failure to handle.

const EMPTY_FORM = { referredFirstName: '', referredLastName: '', relationship: '' };

const MemberReferrals = () => {
  const [form, setForm] = useState(EMPTY_FORM);
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadReferrals = useCallback(async () => {
    try {
      const data = await apiClient.get('/member/referrals');
      setReferrals(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load your referrals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReferrals();
  }, [loadReferrals]);

  const canSubmit =
    form.referredFirstName.trim() && form.referredLastName.trim() && form.relationship.trim();

  const handleChange = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;

    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const created = await apiClient.post('/member/referrals', {
        referredFirstName: form.referredFirstName.trim(),
        referredLastName: form.referredLastName.trim(),
        relationship: form.relationship.trim()
      });
      setForm(EMPTY_FORM);
      setSuccess(
        created?.candidateId
          ? 'Referral submitted and matched to their application.'
          : 'Referral submitted. It will attach to their profile once they apply.'
      );
      await loadReferrals();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not submit that referral.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700, color: 'primary.dark' }}>
          Refer a Candidate
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
          Vouch for someone you think should be in this recruiting cycle. You do not need to wait
          for them to apply — submit their name now and the referral attaches to their profile on
          its own once their application comes through.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Already looking at their application? Add the referral on that page instead.
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 3, mb: 4 }}>
        <Box component="form" onSubmit={handleSubmit}>
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="First name"
                value={form.referredFirstName}
                onChange={handleChange('referredFirstName')}
                required
                fullWidth
                inputProps={{ maxLength: 120 }}
              />
              <TextField
                label="Last name"
                value={form.referredLastName}
                onChange={handleChange('referredLastName')}
                required
                fullWidth
                inputProps={{ maxLength: 120 }}
              />
            </Stack>
            <TextField
              label="How do you know them?"
              value={form.relationship}
              onChange={handleChange('relationship')}
              required
              fullWidth
              placeholder="e.g. Classmate, former teammate, worked together at an internship"
              inputProps={{ maxLength: 120 }}
            />

            {error && <Alert severity="error">{error}</Alert>}
            {success && <Alert severity="success">{success}</Alert>}

            <Box>
              <Button type="submit" variant="contained" disabled={!canSubmit || submitting}>
                {submitting ? 'Submitting…' : 'Submit referral'}
              </Button>
            </Box>
          </Stack>
        </Box>
      </Paper>

      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
        Your referrals
      </Typography>
      <Divider sx={{ mb: 2 }} />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : referrals.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          You have not referred anyone yet.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {referrals.map((referral) => (
            <Paper key={referral.id} variant="outlined" sx={{ p: 2 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                spacing={1}
              >
                <Box>
                  <Typography sx={{ fontWeight: 600 }}>{referral.referredName}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {referral.relationship}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Submitted {new Date(referral.createdAt).toLocaleDateString()}
                    {referral.cycle?.name ? ` · ${referral.cycle.name}` : ''}
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  label={referral.status === 'ATTACHED' ? 'On their profile' : 'Waiting on their application'}
                  color={referral.status === 'ATTACHED' ? 'success' : 'default'}
                  variant={referral.status === 'ATTACHED' ? 'filled' : 'outlined'}
                />
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
};

export default MemberReferrals;
