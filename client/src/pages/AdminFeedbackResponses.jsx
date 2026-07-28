import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Stack,
} from '@mui/material';
import api from '../utils/api';

export default function AdminFeedbackResponses() {
  const [responses, setResponses] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const loadCycles = async () => {
      try {
        const data = await api.get('/admin/cycles');
        setCycles(data || []);
      } catch (e) {
        console.error('Failed to load cycles:', e);
      }
    };
    loadCycles();
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (cycleId) params.set('cycleId', cycleId);
        params.set('page', page + 1);
        params.set('limit', rowsPerPage);
        const data = await api.get(`/admin/feedback-responses?${params.toString()}`);
        setResponses(data.responses || []);
        setTotal(data.total || 0);
      } catch (e) {
        setError(e.message || 'Failed to load feedback responses.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [cycleId, page, rowsPerPage]);

  const handleChangePage = (_, newPage) => setPage(newPage);
  const handleChangeRowsPerPage = (e) => {
    setRowsPerPage(parseInt(e.target.value, 10));
    setPage(0);
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Anonymous Feedback
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <FormControl sx={{ minWidth: 240 }}>
          <InputLabel id="cycle-filter-label">Recruiting Cycle</InputLabel>
          <Select
            labelId="cycle-filter-label"
            value={cycleId}
            label="Recruiting Cycle"
            onChange={(e) => setCycleId(e.target.value)}
          >
            <MenuItem value="">All cycles</MenuItem>
            {cycles.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Paper>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Date Submitted</TableCell>
                  <TableCell>Cycle</TableCell>
                  <TableCell>Feedback</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {responses.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} align="center">
                      No feedback responses yet.
                    </TableCell>
                  </TableRow>
                )}
                {responses.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{new Date(r.submittedAt).toLocaleString()}</TableCell>
                    <TableCell>{r.cycle?.name || 'Unknown'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'pre-wrap' }}>
                      {r.answers && Object.keys(r.answers).length > 0 ? (
                        <Stack spacing={1}>
                          {Object.entries(r.answers).map(([key, value]) => {
                            const question = Array.isArray(r.questionsSnapshot)
                              ? r.questionsSnapshot.find((q) => q.id === key)
                              : null;
                            const label = question?.label || key;
                            return (
                              <Box key={key}>
                                <Typography variant="subtitle2">{label}</Typography>
                                <Typography variant="body2" color="text.secondary">{value}</Typography>
                              </Box>
                            );
                          })}
                        </Stack>
                      ) : (
                        r.content
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={handleChangePage}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={handleChangeRowsPerPage}
            rowsPerPageOptions={[10, 25, 50]}
          />
        </Paper>
      )}
    </Box>
  );
}
