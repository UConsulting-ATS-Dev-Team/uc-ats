import React, { useState } from 'react';
import { Alert, Button, Card, CardContent, Stack, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';

// "Applied to UConsulting?" on the talent profile.
//
// A talent account is sent to this page from everywhere, so an applicant who
// signed up here (or signed in with Google under an address their application
// does not use) could not reach their interview sign-up. Typing the UID they
// applied with sends a code to the address on that application; entering it
// turns this into their applicant account. The server decides everything
// (POST /api/talent/uid, /uid/confirm); this only shows where they are.

const TalentUidLink = ({ claimedUid = '', codePending = false }) => {
  const { refreshUser } = useAuth();
  const navigate = useNavigate();

  const [uid, setUid] = useState(claimedUid);
  const [code, setCode] = useState('');
  // 'idle' | 'code' (a code is out) | 'saved' (nobody applied under it yet)
  const [step, setStep] = useState(codePending ? 'code' : claimedUid ? 'saved' : 'idle');
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const linked = async () => {
    // The account is an applicant's now. Reload it so the route guard stops
    // sending it here, then go where an applicant lands.
    await refreshUser();
    navigate('/', { replace: true });
  };

  const submitUid = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await apiClient.post('/talent/uid', { uid });
      if (data.status === 'LINKED') return await linked();
      setSentTo(data.sentTo || '');
      setCode('');
      setStep(data.status === 'CODE_SENT' ? 'code' : 'saved');
    } catch (err) {
      setError(err.message || 'Failed to save your UID');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setError('');
    try {
      await apiClient.post('/talent/uid/confirm', { code });
      await linked();
    } catch (err) {
      setError(err.message || 'Failed to check the code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="outlined" sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Applied to UConsulting?
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Enter the UCLA UID you applied with to see your application and sign up for interviews.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {step === 'code' ? (
          <>
            <Typography variant="body2" sx={{ mb: 2 }}>
              We emailed an 8-digit code to {sentTo || 'the address on your application'}. Enter it here.
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                size="small"
                label="Code"
                value={code}
                inputProps={{ inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 8 }}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <Button variant="contained" disabled={busy || code.length !== 8} onClick={submitCode}>
                Link my application
              </Button>
              <Button disabled={busy} onClick={() => { setError(''); setStep('idle'); }}>
                Use a different UID
              </Button>
            </Stack>
          </>
        ) : (
          <>
            {step === 'saved' && (
              <Alert severity="info" sx={{ mb: 2 }}>
                We have no application under UID {uid} yet. Once yours arrives, enter it again here
                to link it.
              </Alert>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                size="small"
                label="UCLA UID"
                placeholder="9 digits"
                value={uid}
                inputProps={{ inputMode: 'numeric', maxLength: 11 }}
                onChange={(e) => setUid(e.target.value)}
              />
              <Button
                variant="contained"
                disabled={busy || uid.replace(/\D/g, '').length !== 9}
                onClick={submitUid}
              >
                {step === 'saved' ? 'Check again' : 'Find my application'}
              </Button>
            </Stack>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default TalentUidLink;
