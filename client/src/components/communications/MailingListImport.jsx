import React, { useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import {
  Download as DownloadIcon,
  UploadFile as UploadFileIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';

// The recruiting-interest mailing list is being retired. An admin drops the
// export here and gets back the people the ATS has never heard of, ready to
// save as a CSV.
//
// Nothing is stored. The file goes up, the survivors come back in the same
// response, and the browser saves them - so there is no half-finished import
// to clean up if someone closes the tab.
//
// scripts/import-mailing-list-csv.js is the same operation from the command
// line, and uploads to Drive instead of downloading.

const OUTCOME_LABELS = {
  'already-in-system': 'Already in the ATS',
  'duplicate-in-file': 'Repeated in this file',
  'invalid-email': 'Unreadable address',
  'missing-email': 'No address',
};

const SUMMARY_ROWS = [
  ['kept', 'Kept (not in the ATS)'],
  ['already-in-system', 'Dropped — already in the ATS'],
  ['duplicate-in-file', 'Dropped — repeated in this file'],
  ['invalid-email', 'Dropped — unreadable address'],
  ['missing-email', 'Dropped — no address'],
];

// Mirrors the script's default name, so a list deduped here and a list deduped
// from the command line are not filed under two different conventions.
const downloadName = (sourceName) => {
  const base = (sourceName || 'mailing-list').replace(/\.csv$/i, '');
  return `${base}-deduped-${new Date().toISOString().slice(0, 10)}.csv`;
};

const why = (row) => {
  if (row.outcome === 'already-in-system') {
    return `already in the ATS (${(row.sources || []).join(', ')})`;
  }
  if (row.outcome === 'duplicate-in-file') return `repeat of line ${row.firstSeenAt}`;
  if (row.outcome === 'invalid-email') return `unreadable: "${row.raw}"`;
  return 'no address';
};

export default function MailingListImport() {
  const fileRef = useRef(null);
  // Kept so the column picker can re-send the same file without asking the
  // admin to choose it again.
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  // Held apart from `result`, which every run clears, so the column picker
  // survives a re-run instead of blinking out and back.
  const [headers, setHeaders] = useState([]);
  const [column, setColumn] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showDropped, setShowDropped] = useState(false);

  const run = async (chosenFile, emailColumn) => {
    setLoading(true);
    setError('');
    // The previous run's numbers describe a different file, or the same file
    // read down a different column. Leaving them up next to the new file name
    // would offer a download of the old list under the new one's name.
    setResult(null);
    setShowDropped(false);
    try {
      const form = new FormData();
      form.append('file', chosenFile);
      if (emailColumn) form.append('emailColumn', emailColumn);
      const data = await apiClient.post('/master-communications/mailing-list/dedupe', form);
      setResult(data);
      setHeaders((data.headers || []).filter((h) => h !== '__line'));
      setColumn(data.emailColumn || '');
    } catch (err) {
      setError(err.serverMessage || err.message || 'Could not read that file');
      setResult(null);
      setHeaders([]);
      setColumn('');
    } finally {
      setLoading(false);
    }
  };

  const handleFile = (e) => {
    const chosen = e.target.files?.[0];
    // Let the same file be picked twice in a row - without this, re-selecting
    // it after a failed run fires no change event at all.
    e.target.value = '';
    if (!chosen) return;
    setFile(chosen);
    setHeaders([]);
    setColumn('');
    run(chosen, null);
  };

  // Detection is a guess, and a loose one: with no exact "Email" header it will
  // take the first column merely containing the word, which can be something
  // like "Email Verified". So the picker stays up after a successful run too -
  // a wrong guess here silently dedupes against the wrong field.
  const handleColumn = (e) => {
    const chosen = e.target.value;
    setColumn(chosen);
    if (chosen && file) run(file, chosen);
  };

  const handleDownload = () => {
    const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName(result.fileName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const needsColumn = result && !result.emailColumn;

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        Upload the mailing-list export. Everyone the ATS already knows about is dropped, and
        what is left comes back as a CSV to download. Nothing is saved to the ATS.
      </Alert>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <Button
          variant="contained"
          startIcon={<UploadFileIcon />}
          onClick={() => fileRef.current?.click()}
          disabled={loading}
        >
          Choose CSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
          style={{ display: 'none' }}
        />
        {file && <Typography variant="body2" color="text.secondary">{file.name}</Typography>}
        {loading && <CircularProgress size={20} />}
      </Stack>

      {headers.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            {needsColumn
              ? (result.overrideMissed
                ? 'That column is not in this file. Pick another one.'
                : 'Which column holds the email address?')
              : 'Read down this column. Change it if the wrong one was picked.'}
          </Typography>
          <TextField
            select
            size="small"
            label="Email column"
            value={column}
            onChange={handleColumn}
            disabled={loading}
            sx={{ minWidth: 260 }}
          >
            {headers.map((h) => (
              <MenuItem key={h} value={h}>{h}</MenuItem>
            ))}
          </TextField>
        </Paper>
      )}

      {result?.emailColumn && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 2 }}>
            <Chip size="small" label={`${result.rows} rows read`} />
            <Chip size="small" label={`Email column: ${result.emailColumn}`} />
            <Chip size="small" label={`${result.knownAddresses} known addresses in the ATS`} />
          </Stack>

          <Table size="small" sx={{ mb: 2 }}>
            <TableBody>
              {SUMMARY_ROWS.map(([key, label]) => (
                <TableRow key={key}>
                  <TableCell sx={{ border: 0, py: 0.5 }}>{label}</TableCell>
                  <TableCell align="right" sx={{ border: 0, py: 0.5, fontWeight: key === 'kept' ? 600 : 400 }}>
                    {result.summary.counts[key]}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {Object.keys(result.summary.bySource || {}).length > 0 && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 2 }}>
              Where the already-in-the-ATS rows matched:{' '}
              {Object.entries(result.summary.bySource)
                .sort((a, b) => b[1] - a[1])
                .map(([source, n]) => `${source} ${n}`)
                .join(', ')}
              {' — '}one address can sit in more than one, so these do not sum to the dropped count.
            </Typography>
          )}

          {result.keptCount === 0 ? (
            <Alert severity="warning">
              No rows survived. Either everyone on this list is already in the ATS, or the wrong
              column was used {'—'} check the email column above before treating this as
              the answer.
            </Alert>
          ) : (
            <Button variant="contained" startIcon={<DownloadIcon />} onClick={handleDownload}>
              Download {result.keptCount} row{result.keptCount === 1 ? '' : 's'}
            </Button>
          )}

          {result.dropped.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Button size="small" onClick={() => setShowDropped((v) => !v)}>
                {showDropped ? 'Hide' : 'Show'} {result.dropped.length} dropped row
                {result.dropped.length === 1 ? '' : 's'}
              </Button>
              {showDropped && (
                <Box sx={{ maxHeight: 320, overflow: 'auto', mt: 1 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell>Line</TableCell>
                        <TableCell>Address</TableCell>
                        <TableCell>Reason</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {result.dropped.map((row) => (
                        <TableRow key={row.line}>
                          <TableCell>{row.line}</TableCell>
                          <TableCell>{row.email || row.raw || '(blank)'}</TableCell>
                          <TableCell>
                            {OUTCOME_LABELS[row.outcome]} {'— '} {why(row)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              )}
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
}
