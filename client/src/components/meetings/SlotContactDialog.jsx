import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Email as EmailIcon, Sms as SmsIcon } from '@mui/icons-material';
import api from '../../utils/api';
import { buildImessageUrl } from '../../utils/imessage';
import { buildMailtoUrl, draftSignupMessage } from '../../utils/signupContact';

const EMAIL_SUBJECT = 'Get to Know UC - where to meet';

// Reach everyone booked into a GTKUC slot in one go: a group iMessage or one
// email, opened in the host's own Messages or mail app with a draft that asks
// them to fill in exactly where to meet and how to find them.
export default function SlotContactDialog({ open, onClose, slot, hostName }) {
  const [contacts, setContacts] = useState([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open || !slot) return;
    setError('');
    setNotice('');
    setLoading(true);
    // A response that outlives its open (closed, then opened for another slot)
    // is dropped, or the second slot would show the first slot's people.
    let cancelled = false;
    api
      .get(`/member/meeting-slots/${slot.id}/contacts`)
      .then((data) => {
        if (cancelled) return;
        const list = data?.contacts || [];
        setContacts(list);
        setBody(draftSignupMessage({ hostName, contacts: list, startTime: slot.startTime, location: slot.location }));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load signups');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // Loaded on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slot?.id]);

  const phones = contacts.map((c) => c.phoneNumber).filter(Boolean);
  const missingPhone = contacts.filter((c) => !c.phoneNumber);

  const openAndLog = async (channel, url) => {
    window.location.href = url;
    try {
      await api.post(`/member/meeting-slots/${slot.id}/contacts/log`, { channel, body });
      setNotice(channel === 'imessage' ? 'Opened in Messages.' : 'Opened in your mail app.');
    } catch (e) {
      // The message is already open in their app; only the log entry is missing.
      setError(`Opened, but it could not be logged: ${e.message}`);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        Contact signups
        {slot && (
          <Typography variant="body2" color="text.secondary">
            Everyone booked into this slot, in one group message
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
            {notice}
          </Alert>
        )}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: 2 }}>
              {contacts.map((c) => (
                <Chip
                  key={c.signupId}
                  label={c.phoneNumber ? `${c.fullName} · ${c.phoneNumber}` : `${c.fullName} · no phone`}
                  variant={c.phoneNumber ? 'filled' : 'outlined'}
                  size="small"
                />
              ))}
            </Stack>
            {missingPhone.length > 0 && (
              <Alert severity="info" sx={{ mb: 2 }}>
                {missingPhone.length === contacts.length
                  ? 'Nobody here has a phone number on file, so use email.'
                  : `${missingPhone.map((c) => c.fullName).join(', ')} ${missingPhone.length === 1 ? 'has' : 'have'} no phone number on file and won't be in the group iMessage. Email reaches everyone.`}
              </Alert>
            )}
            <TextField
              label="Message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              multiline
              minRows={7}
              fullWidth
              helperText="Replace the bracketed parts with exactly where to meet and how to find you."
            />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          startIcon={<EmailIcon />}
          variant="outlined"
          disabled={loading || contacts.length === 0}
          onClick={() => openAndLog('email', buildMailtoUrl(contacts.map((c) => c.email), EMAIL_SUBJECT, body))}
        >
          Email ({contacts.length})
        </Button>
        <Button
          startIcon={<SmsIcon />}
          variant="contained"
          disabled={loading || phones.length === 0}
          onClick={() => openAndLog('imessage', buildImessageUrl(phones, body))}
        >
          Group iMessage ({phones.length})
        </Button>
      </DialogActions>
    </Dialog>
  );
}
