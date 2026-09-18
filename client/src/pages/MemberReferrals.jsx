import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
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

// Refer a candidate.
//
// The member starts typing and picks the person out of this cycle's applicants,
// which settles who the referral is about with no guessing at all. When the
// person is not in the list yet, "Other" takes a typed name instead: the
// referral waits unattached until form sync sees an application under that
// name, and an admin can match it by hand if the name never lines up.
//
// If they never apply, the referral simply stays pending. That is the intended
// end state, not a failure to handle.

const OTHER = { id: '__other__', isOther: true };

const EMPTY_FORM = { referredFirstName: '', referredLastName: '', relationship: '' };

const candidateLabel = (option) => {
  if (!option) return '';
  if (option.isOther) return 'Other — not in this list';
  const name = [option.firstName, option.lastName].filter(Boolean).join(' ');
  return option.email ? `${name} (${option.email})` : name;
};

const MemberReferrals = () => {
  const [form, setForm] = useState(EMPTY_FORM);
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Candidate picker
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  const isOther = selected?.isOther === true;

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

  // Debounced candidate search. Each run carries a sequence number so a slow
  // response for an old query cannot overwrite the results of a newer one.
  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) {
      setOptions([]);
      setSearching(false);
      return undefined;
    }

    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await apiClient.get(`/member/referral-candidates?q=${encodeURIComponent(query)}`);
        if (seq !== searchSeq.current) return;
        setOptions(Array.isArray(data) ? data : []);
      } catch {
        if (seq === searchSeq.current) setOptions([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [search]);

  // "Other" is always offered, so a member is never stuck when the person they
  // want is not in the system yet.
  const pickerOptions = useMemo(() => [...options, OTHER], [options]);

  const canSubmit = Boolean(
    form.relationship.trim() &&
      (isOther
        ? form.referredFirstName.trim() && form.referredLastName.trim()
        : selected?.id)
  );

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
        relationship: form.relationship.trim(),
        ...(isOther
          ? {
              referredFirstName: form.referredFirstName.trim(),
              referredLastName: form.referredLastName.trim()
            }
          : { candidateId: selected.id })
      });
      setForm(EMPTY_FORM);
      setSelected(null);
      setSearch('');
      setSuccess(
        created?.candidateId
          ? 'Referral submitted and added to their profile.'
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
          Vouch for someone you think should be in this recruiting cycle. Start typing and pick
          them from the list. If they have not applied yet, choose Other and enter their name —
          the referral attaches to their profile on its own once their application comes through.
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 3, mb: 4 }}>
        <Box component="form" onSubmit={handleSubmit}>
          <Stack spacing={2}>
            <Autocomplete
              value={selected}
              onChange={(_event, value) => setSelected(value)}
              inputValue={search}
              onInputChange={(_event, value) => setSearch(value)}
              options={pickerOptions}
              getOptionLabel={candidateLabel}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              filterOptions={(opts) => opts}
              loading={searching}
              noOptionsText={search.trim().length < 2 ? 'Type at least two letters' : 'No matches'}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Who are you referring?"
                  required
                  placeholder="Start typing a name"
                  helperText="Pick them from the list, or choose Other if they have not applied yet"
                  InputProps={{
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {searching ? <CircularProgress size={18} /> : null}
                        {params.InputProps.endAdornment}
                      </>
                    )
                  }}
                />
              )}
            />

            {isOther && (
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
            )}

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
