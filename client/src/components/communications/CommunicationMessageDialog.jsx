import React from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { CATEGORY_LABELS, CHANNEL_LABELS, labelFor, statusStyleFor } from './communicationLabels';

/** One communications log row, as Logs and the candidate pages open it. */
const CommunicationMessageDialog = ({ message, onClose }) => {
  const status = message ? statusStyleFor(message) : null;
  return (
    <Dialog open={Boolean(message)} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{message?.subject || 'Message'}</DialogTitle>
      <DialogContent dividers>
        {message && (
          <Stack spacing={1.5}>
            <Typography variant="body2">
              <strong>To:</strong>{' '}
              {message.recipientName ? `${message.recipientName} <${message.recipient}>` : message.recipient}
            </Typography>
            <Typography variant="body2">
              <strong>Sent:</strong> {new Date(message.sentAt).toLocaleString()}
            </Typography>
            <Typography variant="body2">
              <strong>Channel:</strong> {labelFor(CHANNEL_LABELS, message.channel)} ·{' '}
              <strong>Type:</strong> {labelFor(CATEGORY_LABELS, message.category)} ·{' '}
              <strong>{message.trigger === 'MANUAL' ? 'Sent by a person' : 'Automated'}</strong>
            </Typography>
            {message.cycle?.name && (
              <Typography variant="body2">
                <strong>Cycle:</strong> {message.cycle.name}
              </Typography>
            )}
            {message.status === 'SENDING' && (
              <Alert severity={status.label === 'Interrupted' ? 'error' : 'info'}>
                {status.label === 'Interrupted'
                  ? 'This send was interrupted before the email server answered, so it may not have arrived. Check the list for a later attempt.'
                  : 'Was being sent when this list loaded. Reload the list to see how it ended.'}
              </Alert>
            )}
            {message.error && <Alert severity="error">{message.error}</Alert>}
            <Typography variant="caption" color="text.secondary">
              Message (first 2000 characters, formatting removed)
            </Typography>
            <Box
              component="pre"
              sx={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'inherit',
                bgcolor: 'action.hover',
                borderRadius: 1,
                p: 1.5,
                m: 0,
              }}
            >
              {message.bodyPreview || 'No body recorded.'}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default CommunicationMessageDialog;
