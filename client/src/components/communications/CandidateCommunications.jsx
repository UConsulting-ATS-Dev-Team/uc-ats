import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import apiClient from '../../utils/api';
import CommunicationMessageDialog from './CommunicationMessageDialog';
import { CATEGORY_LABELS, CHANNEL_LABELS, labelFor, statusStyleFor } from './communicationLabels';

const PAGE_SIZE = 25;

/**
 * Every message the communications log holds for one candidate, newest first.
 * The server finds them by every address and number the candidate is known by
 * (services/candidateCommunications.js); the caption says which, so a row
 * that went to an old personal address is not a mystery. Admin only.
 */
const CandidateCommunications = ({ candidateId }) => {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [matchedOn, setMatchedOn] = useState(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    setRows([]);
    setOffset(0);
  }, [candidateId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiClient.get(
          `/admin/candidate-communications/${candidateId}?limit=${PAGE_SIZE}&offset=${offset}`
        );
        if (cancelled) return;
        setRows((prev) => (offset === 0 ? data.rows : [...prev, ...data.rows]));
        setTotal(data.total);
        setMatchedOn(data.matchedOn);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load communications');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [candidateId, offset]);

  const searched = matchedOn ? [...matchedOn.emails, ...matchedOn.phones] : [];

  return (
    <div className="detail-section detail-section-wide">
      <h3 className="section-title">Communications ({total})</h3>
      {searched.length > 0 && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          Everything sent to {searched.join(', ')}
        </Typography>
      )}

      {error && <Alert severity="error">{error}</Alert>}

      {loading && rows.length === 0 ? (
        <Stack alignItems="center" sx={{ py: 3 }}>
          <CircularProgress size={24} />
        </Stack>
      ) : rows.length === 0 && !error ? (
        <p className="no-data">Nothing has been sent to this candidate</p>
      ) : (
        rows.length > 0 && (
          <>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Sent at</TableCell>
                  <TableCell>Channel</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Subject</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const status = statusStyleFor(row);
                  return (
                    <TableRow key={row.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelected(row)}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(row.sentAt).toLocaleString()}</TableCell>
                      <TableCell>{labelFor(CHANNEL_LABELS, row.channel)}</TableCell>
                      <TableCell>{labelFor(CATEGORY_LABELS, row.category)}</TableCell>
                      <TableCell>{row.subject || <em>no subject</em>}</TableCell>
                      <TableCell>
                        <Chip size="small" color={status.color} label={status.label} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary">
                Showing {rows.length} of {total}
              </Typography>
              {rows.length < total && (
                <Button size="small" disabled={loading} onClick={() => setOffset(rows.length)}>
                  {loading ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </Stack>
          </>
        )
      )}

      <CommunicationMessageDialog message={selected} onClose={() => setSelected(null)} />
    </div>
  );
};

export default CandidateCommunications;
