import React, { useEffect, useState } from 'react';
import { Alert, Dialog, DialogActions, DialogContent, DialogTitle, Button, Typography } from '@mui/material';
import apiClient from '../../utils/api';
import ImessageComposer from './ImessageComposer';

// A one-off iMessage from anywhere in the app, starting from a known group of
// people - an interview session's interviewers, say. Same composer as Master
// Communications, minus drafts: the admin can pick a template or write one,
// and add anyone else to the chat before sending.
export default function ImessageSendDialog({ open, onClose, title, subtitle, initialMemberIds = [], cycleId, onSent }) {
  const [body, setBody] = useState('');
  const [memberIds, setMemberIds] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [error, setError] = useState('');

  // Start clean each time it opens, seeded with the group it was opened for.
  useEffect(() => {
    if (!open) return;
    setBody('');
    setSelectedTemplate('');
    setError('');
    setMemberIds(initialMemberIds);
    const query = cycleId ? `?cycleId=${cycleId}` : '';
    apiClient
      .get(`/master-communications/templates${query}`)
      .then((data) => setTemplates((Array.isArray(data) ? data : []).filter((t) => t.channel === 'imessage')))
      .catch((e) => setError(e.message || 'Failed to load templates'));
    // Seeded on open only; the caller rebuilds initialMemberIds on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cycleId]);

  const selectTemplate = (id) => {
    setSelectedTemplate(id);
    const template = templates.find((t) => t.id === id);
    if (template) setBody(template.body || '');
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>
        {title}
        {subtitle && (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {open && (
          <ImessageComposer
            body={body}
            onBodyChange={setBody}
            templates={templates}
            selectedTemplate={selectedTemplate}
            onSelectTemplate={selectTemplate}
            memberIds={memberIds}
            onMemberIdsChange={setMemberIds}
            cycleId={cycleId}
            onError={setError}
            onSuccess={(message) => {
              onSent?.(message);
              onClose();
            }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
