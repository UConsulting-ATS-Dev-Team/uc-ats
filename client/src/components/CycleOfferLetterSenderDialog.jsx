import React, { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

function statusLabel(status) {
  if (status === 'sent') return 'Sent';
  if (status === 'pending') return 'In progress';
  if (status === 'failed') return 'Failed';
  return 'Not sent';
}

export default function CycleOfferLetterSenderDialog({ cycleId, open, onClose }) {
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [force, setForce] = useState(false);

  const [form, setForm] = useState({
    position: '',
    startDate: '',
    responseDeadline: ''
  });

  const fetchCandidates = async () => {
    if (!cycleId) return;
    setLoading(true);
    try {
      const data = await apiClient.get(`/admin/cycles/${cycleId}/offer-letter-candidates`);
      setCandidates(data.candidates || []);
      setSelected(new Set());
    } catch (e) {
      setError(e.message || 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !cycleId) return;
    let cancelled = false;
    setError('');
    setSuccess('');
    setSelected(new Set());
    setForm({ position: '', startDate: '', responseDeadline: '' });

    const load = async () => {
      setLoading(true);
      try {
        const [candData, tmpl] = await Promise.all([
          apiClient.get(`/admin/cycles/${cycleId}/offer-letter-candidates`),
          apiClient.get(`/admin/cycles/${cycleId}/offer-letter-template`)
        ]);
        if (cancelled) return;
        setCandidates(candData.candidates || []);
        setTemplate(tmpl);
        setForm((prev) => ({
          ...prev,
          responseDeadline: tmpl.responseDeadline || prev.responseDeadline
        }));
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [cycleId, open]);

  const toggleSelect = (applicationId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(applicationId)) next.delete(applicationId);
      else next.add(applicationId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === candidates.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(candidates.map((c) => c.applicationId)));
    }
  };

  const handleChange = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setError('');
    setSuccess('');
  };

  const handleSend = async () => {
    setError('');
    setSuccess('');

    if (selected.size === 0) {
      setError('Select at least one candidate');
      return;
    }
    if (!form.position.trim() || !form.responseDeadline.trim()) {
      setError('Position and response deadline are required');
      return;
    }

    setSending(true);
    try {
      const { results } = await apiClient.post(`/admin/cycles/${cycleId}/send-offer-letters`, {
        applicationIds: Array.from(selected),
        position: form.position.trim(),
        startDate: form.startDate.trim(),
        responseDeadline: form.responseDeadline.trim(),
        force
      });

      const sent = results.filter((r) => r.success).length;
      const alreadySent = results.filter((r) => r.alreadySent).length;
      const failed = results.filter((r) => !r.success && !r.alreadySent).length;
      setSuccess(`Sent: ${sent}, Already sent/skipped: ${alreadySent}, Failed: ${failed}`);
      await fetchCandidates();
      setSelected(new Set());
    } catch (e) {
      setError(e.message || 'Failed to send offer letters');
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    if (sending) return;
    onClose?.();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Send Offer Letters
        <IconButton
          aria-label="close"
          onClick={handleClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
          disabled={sending}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}
        {success && (
          <Typography color="success.main" sx={{ mb: 2 }}>
            {success}
          </Typography>
        )}
        {loading ? (
          <Typography color="text.secondary">Loading candidates...</Typography>
        ) : (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Position"
              value={form.position}
              onChange={handleChange('position')}
              fullWidth
            />
            <TextField
              label="Start Date"
              value={form.startDate}
              onChange={handleChange('startDate')}
              fullWidth
            />
            <TextField
              label="Response Deadline"
              value={form.responseDeadline}
              onChange={handleChange('responseDeadline')}
              fullWidth
            />

            <FormControlLabel
              control={
                <Checkbox
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                />
              }
              label="Force resend to candidates who already received an offer letter"
            />

            <Typography variant="subtitle2">
              Final Round Accepted Candidates
            </Typography>

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={candidates.length > 0 && selected.size === candidates.length}
                      indeterminate={selected.size > 0 && selected.size < candidates.length}
                      onChange={toggleSelectAll}
                    />
                  </TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Sent At</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={c.applicationId} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={selected.has(c.applicationId)}
                        onChange={() => toggleSelect(c.applicationId)}
                      />
                    </TableCell>
                    <TableCell>{c.firstName} {c.lastName}</TableCell>
                    <TableCell>{c.email}</TableCell>
                    <TableCell>{statusLabel(c.status)}</TableCell>
                    <TableCell>{c.sentAt ? new Date(c.sentAt).toLocaleString() : '-'}</TableCell>
                  </TableRow>
                ))}
                {candidates.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center">
                      No Final Round accepted candidates found for this cycle.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={sending}>
          Cancel
        </Button>
        <Button
          onClick={handleSend}
          variant="contained"
          disabled={sending || selected.size === 0 || !form.position.trim() || !form.responseDeadline.trim()}
        >
          {sending ? 'Sending...' : `Send to ${selected.size} Selected`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
