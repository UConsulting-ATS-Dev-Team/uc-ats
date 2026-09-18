import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography
} from '@mui/material';
import apiClient from '../utils/api';

// Referrals members submitted, and the queue of ones that never found their
// person.
//
// A referral goes pending when the member picked "Other" for someone who has
// not applied, when the name they typed does not line up with what the
// applicant wrote, or when two applicants in the cycle share that name and the
// claim was held back rather than guessed. All three are resolved the same way:
// an admin says who it is.

const TABS = [
  { value: 'PENDING', label: 'Needs matching' },
  { value: 'ATTACHED', label: 'Matched' }
];

const candidateLabel = (option) => {
  if (!option) return '';
  const name = [option.firstName, option.lastName].filter(Boolean).join(' ');
  return option.email ? `${name} (${option.email})` : name;
};

const CandidatePicker = ({ onPick, disabled }) => {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState([]);
  const [searching, setSearching] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) {
      setOptions([]);
      setSearching(false);
      return undefined;
    }

    const seq = ++seqRef.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await apiClient.get(`/admin/referral-candidates?q=${encodeURIComponent(query)}`);
        if (seq !== seqRef.current) return;
        setOptions(Array.isArray(data) ? data : []);
      } catch {
        if (seq === seqRef.current) setOptions([]);
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [search]);

  return (
    <Autocomplete
      size="small"
      sx={{ minWidth: 280 }}
      disabled={disabled}
      options={options}
      getOptionLabel={candidateLabel}
      isOptionEqualToValue={(option, value) => option.id === value.id}
      filterOptions={(opts) => opts}
      loading={searching}
      inputValue={search}
      onInputChange={(_event, value) => setSearch(value)}
      onChange={(_event, value) => {
        if (value) onPick(value);
      }}
      noOptionsText={search.trim().length < 2 ? 'Type at least two letters' : 'No matches'}
      renderInput={(params) => (
        <TextField
          {...params}
          label="Match to candidate"
          placeholder="Search by name or email"
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {searching ? <CircularProgress size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            )
          }}
        />
      )}
    />
  );
};

const AdminReferrals = () => {
  const [status, setStatus] = useState('PENDING');
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.get(`/admin/referrals?status=${status}`);
      setReferrals(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load referrals.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const attach = async (referral, candidate) => {
    setSavingId(referral.id);
    setError('');
    setSuccess('');
    try {
      await apiClient.patch(`/admin/referrals/${referral.id}`, { candidateId: candidate.id });
      setSuccess(`${referral.referredName} matched to ${candidateLabel(candidate)}.`);
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not match that referral.');
    } finally {
      setSavingId(null);
    }
  };

  const heading = useMemo(
    () => (status === 'PENDING' ? 'Referrals waiting on a match' : 'Matched referrals'),
    [status]
  );

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700, color: 'primary.dark' }}>
          Referrals
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
          Members refer people from their own Refer a Candidate page. Most attach on their own.
          The ones here did not, either because the person has not applied yet or because the name
          was not enough to decide on.
        </Typography>
      </Box>

      <Tabs value={status} onChange={(_event, value) => setStatus(value)} sx={{ mb: 2 }}>
        {TABS.map((tab) => (
          <Tab key={tab.value} value={tab.value} label={tab.label} />
        ))}
      </Tabs>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1.5 }}>
        {heading}
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : referrals.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {status === 'PENDING' ? 'Nothing is waiting. ' : 'No matched referrals yet. '}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {referrals.map((referral) => (
            <Paper key={referral.id} variant="outlined" sx={{ p: 2 }}>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                alignItems={{ xs: 'stretch', md: 'center' }}
                spacing={2}
              >
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Typography sx={{ fontWeight: 600 }}>{referral.referredName}</Typography>
                    {referral.source === 'PRE_APPLICATION' && (
                      <Chip size="small" variant="outlined" label="Member submitted" />
                    )}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    Referred by {referral.referredBy?.fullName || referral.referrerName} ·{' '}
                    {referral.relationship}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Submitted {new Date(referral.createdAt).toLocaleDateString()}
                  </Typography>
                </Box>

                {referral.status === 'PENDING' ? (
                  <CandidatePicker
                    disabled={savingId === referral.id}
                    onPick={(candidate) => attach(referral, candidate)}
                  />
                ) : referral.locked ? (
                  <Chip size="small" label="Sealed record" />
                ) : (
                  <Button
                    size="small"
                    href={`/candidate-detail/${referral.candidateId}`}
                    disabled={!referral.candidateId}
                  >
                    View profile
                  </Button>
                )}
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
};

export default AdminReferrals;
