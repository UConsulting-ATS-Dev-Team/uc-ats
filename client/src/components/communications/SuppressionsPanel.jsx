import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Stack,
  TextField,
  Button,
  Chip,
  Alert,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  FormControlLabel,
  Checkbox,
  Typography,
} from '@mui/material';
import apiClient from '../../utils/api';

// Who is held back from Master Communications marketing sends. People add
// themselves from the footer link; SES adds hard bounces and spam complaints.
// Staff are never held back, so a member on this list still gets member mail.

const REASON_LABELS = {
  UNSUBSCRIBED: 'Unsubscribed',
  BOUNCED: 'Address bounced',
  COMPLAINED: 'Marked as spam',
  ADMIN: 'Added by an admin',
};

const REASON_COLORS = { UNSUBSCRIBED: 'default', BOUNCED: 'warning', COMPLAINED: 'error', ADMIN: 'info' };

export default function SuppressionsPanel() {
  const [data, setData] = useState({ rows: [], total: 0, activeByReason: {} });
  const [search, setSearch] = useState('');
  const [includeResubscribed, setIncludeResubscribed] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newNote, setNewNote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (search.trim()) params.set('search', search.trim());
      if (includeResubscribed) params.set('includeResubscribed', 'true');
      setData(await apiClient.get(`/master-communications/suppressions?${params}`));
      setError('');
    } catch (e) {
      setError(e.message || 'Failed to load unsubscribes');
    }
  }, [search, includeResubscribed]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const suppress = async (email, note) => {
    try {
      await apiClient.post('/master-communications/suppressions', { email, note: note || null });
      setNotice(`${email} will no longer get marketing sends`);
      return true;
    } catch (e) {
      setError(e.message || 'Failed to add');
      return false;
    } finally {
      load();
    }
  };

  const add = async () => {
    if (await suppress(newEmail.trim(), newNote.trim())) {
      setNewEmail('');
      setNewNote('');
    }
  };

  const resubscribe = async (email) => {
    if (!window.confirm(`Send marketing email to ${email} again? Only do this if they asked.`)) return;
    try {
      await apiClient.delete(`/master-communications/suppressions/${encodeURIComponent(email)}`);
      setNotice(`${email} resubscribed`);
      load();
    } catch (e) {
      setError(e.message || 'Failed to resubscribe');
    }
  };

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        These addresses are skipped on every filtered or applicant send. Member and admin mail, decision
        letters and account emails are not affected.
      </Alert>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>{notice}</Alert>}

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        {Object.entries(REASON_LABELS).map(([reason, label]) => (
          <Chip key={reason} size="small" label={`${label}: ${data.activeByReason?.[reason] || 0}`} />
        ))}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }} alignItems={{ sm: 'center' }}>
        <TextField size="small" label="Search address" value={search} onChange={(e) => setSearch(e.target.value)} />
        <FormControlLabel
          control={<Checkbox checked={includeResubscribed} onChange={(e) => setIncludeResubscribed(e.target.checked)} />}
          label="Include resubscribed"
        />
        <Box sx={{ flexGrow: 1 }} />
        <TextField size="small" label="Add an address" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
        <TextField size="small" label="Note (optional)" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
        <Button variant="outlined" onClick={add} disabled={!newEmail.includes('@')}>Unsubscribe</Button>
      </Stack>

      {data.rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">Nobody here.</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Address</TableCell>
              <TableCell>Reason</TableCell>
              <TableCell>Detail</TableCell>
              <TableCell>Since</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {data.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.email}</TableCell>
                <TableCell>
                  <Chip size="small" color={REASON_COLORS[row.reason] || 'default'} label={REASON_LABELS[row.reason] || row.reason} />
                </TableCell>
                <TableCell sx={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.detail || (row.source === 'ONE_CLICK' ? "Via their mail app's unsubscribe button" : '')}
                </TableCell>
                <TableCell>{new Date(row.updatedAt).toLocaleDateString()}</TableCell>
                <TableCell align="right">
                  {row.resubscribedAt ? (
                    <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
                      <Typography variant="caption" color="text.secondary">
                        Resubscribed {new Date(row.resubscribedAt).toLocaleDateString()}
                      </Typography>
                      <Button size="small" onClick={() => suppress(row.email)}>Unsubscribe again</Button>
                    </Stack>
                  ) : (
                    <Button size="small" onClick={() => resubscribe(row.email)}>Resubscribe</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data.total > data.rows.length && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Showing {data.rows.length} of {data.total}. Search to narrow it down.
        </Typography>
      )}
    </Box>
  );
}
