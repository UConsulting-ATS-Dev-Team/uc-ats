import React, { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Container,
  Link,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import UConsultingLogo from '../components/UConsultingLogo';

// Landing page for the link in the verification email.
//
// Unauthenticated on purpose: the link is usually opened in whatever browser the
// mail client hands it to, which is often not the one the person signed up in.
// The endpoint returns a fresh session on success, so clicking the link both
// verifies the address and signs them in wherever they opened it.

const TalentVerifyEmail = () => {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { token: sessionToken, refreshUser } = useAuth();

  const [state, setState] = useState(token ? 'verifying' : 'missing');
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  const [resendEmail, setResendEmail] = useState('');

  // React 18 StrictMode mounts effects twice in development. The token is
  // single-use, so the second call would report "invalid or already used" and
  // overwrite a success that just happened.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    const verify = async () => {
      try {
        const data = await apiClient.post('/auth/verify-email', { token });
        localStorage.setItem('token', data.token);
        apiClient.setToken(data.token);
        setState('done');
        // Pull the freshly verified user into context if a session was already
        // open in this browser, so the profile page does not render its
        // "unverified" banner for a moment before catching up.
        if (sessionToken) await refreshUser();
      } catch (err) {
        setError(err.message || 'That verification link did not work.');
        setState('failed');
      }
    };

    verify();
  }, [token, sessionToken, refreshUser]);

  const resend = async () => {
    setError('');
    try {
      await apiClient.post('/auth/resend-verification', { email: resendEmail.trim() });
      setResent(true);
    } catch (err) {
      setError(err.message || 'Failed to resend the verification email.');
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        backgroundColor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        py: 6,
      }}
    >
      <Container maxWidth="sm">
        <Paper elevation={3} sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={2} alignItems="center">
            <UConsultingLogo />

            {state === 'verifying' && (
              <>
                <CircularProgress />
                <Typography>Verifying your email...</Typography>
              </>
            )}

            {state === 'done' && (
              <>
                <Alert severity="success" sx={{ width: '100%' }}>
                  Your UCLA email is verified.
                </Alert>
                <Typography variant="body2" color="text.secondary" align="center">
                  You can now upload your resume and choose whether to share it with partner
                  organizations.
                </Typography>
                <Button variant="contained" onClick={() => navigate('/talent/profile')}>
                  Go to my profile
                </Button>
              </>
            )}

            {(state === 'failed' || state === 'missing') && (
              <>
                <Alert severity="error" sx={{ width: '100%' }}>
                  {state === 'missing'
                    ? 'This page needs a verification link. Check your email for the one we sent.'
                    : error}
                </Alert>

                {resent ? (
                  <Alert severity="info" sx={{ width: '100%' }}>
                    If that account still needs verification, a new link is on its way.
                  </Alert>
                ) : (
                  <>
                    <Typography variant="body2" color="text.secondary" align="center">
                      Links expire after 24 hours and can only be used once. Enter your UCLA email
                      to get a new one.
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ width: '100%' }}>
                      <input
                        style={{ flex: 1, padding: '8px' }}
                        type="email"
                        placeholder="you@g.ucla.edu"
                        value={resendEmail}
                        onChange={(e) => setResendEmail(e.target.value)}
                      />
                      <Button variant="outlined" disabled={!resendEmail.trim()} onClick={resend}>
                        Resend
                      </Button>
                    </Stack>
                  </>
                )}

                <Link component={RouterLink} to="/login" variant="body2">
                  Back to sign in
                </Link>
              </>
            )}
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
};

export default TalentVerifyEmail;
