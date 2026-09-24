import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Button, Paper, Typography, Alert, Container, CircularProgress } from '@mui/material';
import UConsultingLogo from '../components/UConsultingLogo';

// Where the footer link of a Master Communications email lands. Public, and
// deliberately a page with a button rather than a link that acts: mail scanners
// open every URL in a message, and one that unsubscribed on GET would opt people
// out without them ever reading the mail.
//
// Plain fetch, not apiClient: this page must work for someone with no account,
// and must not send a signed-in admin's token along with somebody else's link.

const call = async (method, path, body) => {
  const res = await fetch(`/api/unsubscribe${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
};

export default function Unsubscribe() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t') || '';
  const [state, setState] = useState({ loading: true, email: '', unsubscribed: false, heldBack: false, error: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ loading: false, email: '', unsubscribed: false, error: 'This unsubscribe link is incomplete. Copy the whole link from the email.' });
      return;
    }
    call('GET', `?t=${encodeURIComponent(token)}`)
      .then((data) => setState({ loading: false, email: data.email, unsubscribed: data.unsubscribed, heldBack: Boolean(data.heldBack), error: '' }))
      .catch((e) => setState({ loading: false, email: '', unsubscribed: false, error: e.message }));
  }, [token]);

  const act = async (path) => {
    setBusy(true);
    try {
      const data = await call('POST', path, { t: token });
      setState((s) => ({ ...s, unsubscribed: data.unsubscribed, heldBack: Boolean(data.heldBack), error: '' }));
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 4, sm: 8 } }}>
      <Paper sx={{ p: { xs: 3, sm: 4 }, textAlign: 'center' }}>
        <Box sx={{ mb: 3 }}>
          <UConsultingLogo />
        </Box>

        {state.loading ? (
          <CircularProgress />
        ) : state.error && !state.email ? (
          <Alert severity="error">{state.error}</Alert>
        ) : (
          <>
            <Typography variant="h5" gutterBottom>
              {state.unsubscribed ? "You're unsubscribed" : 'Unsubscribe from UConsulting emails?'}
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              {state.unsubscribed ? (
                <>
                  <strong>{state.email}</strong> won't get recruiting news or event emails from us any more. If you
                  have an application open, you'll still hear about it.
                </>
              ) : (
                <>
                  <strong>{state.email}</strong> will stop getting recruiting news and event emails from UConsulting.
                  Emails about an application you've submitted will still reach you.
                </>
              )}
            </Typography>

            {state.error && <Alert severity="error" sx={{ mb: 2 }}>{state.error}</Alert>}

            {/* A bounce, complaint or admin block on the other spelling of a
                UCLA inbox (g.ucla.edu / ucla.edu). Nothing on this page lifts it. */}
            {state.heldBack && (
              <Alert severity="info" sx={{ mb: 2, textAlign: 'left' }}>
                We've also paused these emails to this inbox on our side, for example because an earlier
                message wasn't delivered, so{' '}
                {state.unsubscribed ? 'resubscribing here will not start them again' : "you won't get them for now"}.
                Reply to any UConsulting email if you'd like them turned back on.
              </Alert>
            )}

            {state.unsubscribed ? (
              <Button variant="outlined" disabled={busy} onClick={() => act('/resubscribe')}>
                I changed my mind, resubscribe me
              </Button>
            ) : (
              <Button variant="contained" color="error" disabled={busy} onClick={() => act('')}>
                Unsubscribe
              </Button>
            )}
          </>
        )}
      </Paper>
    </Container>
  );
}
