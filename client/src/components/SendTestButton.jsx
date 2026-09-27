import React, { useState } from 'react';
import { Alert, Button, Stack } from '@mui/material';
import { Send as SendIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

/**
 * Emails one automatic email, with sample data, to the admin clicking - and
 * nobody else. `draft` is whatever the surrounding editor has not saved yet
 * ({ copy }, { style }, ...), so "how does this look in Gmail" can be answered
 * before committing to it. The server validates it as a save would.
 */
export default function SendTestButton({ previewKey, draft = null, label = 'Send test to me' }) {
  const [state, setState] = useState({ sending: false, message: '', severity: 'success' });

  const send = () => {
    setState({ sending: true, message: '', severity: 'success' });
    apiClient
      .post(`/admin/email-templates/${encodeURIComponent(previewKey)}/test`, draft ?? {})
      .then((data) =>
        setState({
          sending: false,
          severity: 'success',
          message: `Sent to ${data.sentTo}${draft ? ', with your unsaved changes' : ''}. Only you received it.`,
        })
      )
      .catch((err) =>
        setState({ sending: false, severity: 'error', message: err.serverMessage || 'The test email could not be sent' })
      );
  };

  return (
    <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
      <Button size="small" variant="outlined" startIcon={<SendIcon />} disabled={state.sending || !previewKey} onClick={send}>
        {state.sending ? 'Sending…' : label}
      </Button>
      {state.message && (
        <Alert severity={state.severity} onClose={() => setState((s) => ({ ...s, message: '' }))} sx={{ width: '100%' }}>
          {state.message}
        </Alert>
      )}
    </Stack>
  );
}
