import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  Grid,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import apiClient from '../utils/api';
import { MAJOR_OPTIONS, OTHER_MAJOR } from '../utils/majors';
import { GRADUATION_YEARS } from '../utils/graduationYears';
import DocumentPreviewModal from './DocumentPreviewModal';

// A member's own resume for the Talent Partner Network, plus the consent that
// makes it shareable. Sharing is strictly opt-in, and withdrawing pulls the
// resume back from every partner immediately.

const emptyForm = { major1: '', major2: '', graduationYear: '', gender: '' };

const MemberResumeCard = () => {
  const [resume, setResume] = useState(null);
  const [genders, setGenders] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [file, setFile] = useState(null);
  const [consent, setConsent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [major1Other, setMajor1Other] = useState('');
  const [major2Other, setMajor2Other] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get('/member/resume');
      setResume(data.resume);
      setGenders(data.genders || []);
      if (data.resume) {
        // A stored major that is not one of the options came from "Other" -
        // members who filled this in when it was a free-text field are the
        // common case, and dropping their answer on load would be worse than
        // the typo the dropdown exists to prevent.
        const bucket = (value) =>
          MAJOR_OPTIONS.includes(value) ? value : value ? OTHER_MAJOR : '';

        setForm({
          major1: bucket(data.resume.major1),
          major2: bucket(data.resume.major2),
          graduationYear: data.resume.graduationYear || '',
          gender: data.resume.gender || '',
        });
        setMajor1Other(MAJOR_OPTIONS.includes(data.resume.major1) ? '' : data.resume.major1 || '');
        setMajor2Other(MAJOR_OPTIONS.includes(data.resume.major2) ? '' : data.resume.major2 || '');
        setConsent(String(Boolean(data.resume.shareConsent)));
      }
    } catch (err) {
      setError(err.message || 'Failed to load your resume');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async () => {
    if (!file) {
      setError('Attach your resume as a PDF.');
      return;
    }

    // Caught here rather than at the server so the file selection survives -
    // a rejected upload that also cleared the chosen PDF would make a typo
    // cost two steps to fix.
    if (form.major1 === OTHER_MAJOR && !major1Other.trim()) {
      setError('Type your major.');
      return;
    }
    if (form.major2 === OTHER_MAJOR && !major2Other.trim()) {
      setError('Type your second major, or choose one from the list.');
      return;
    }

    if (!form.graduationYear) {
      setError('Choose your graduation year.');
      return;
    }

    if (consent !== 'true' && consent !== 'false') {
      setError('Choose whether we may share your resume with partner organizations.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const body = new FormData();
      body.append('resume', file);
      // The sentinel never leaves this component - what is stored is the typed
      // major, so it filters alongside every other major in the pool.
      body.append('major1', form.major1 === OTHER_MAJOR ? major1Other.trim() : form.major1);
      body.append('major2', form.major2 === OTHER_MAJOR ? major2Other.trim() : form.major2);
      body.append('graduationYear', form.graduationYear);
      body.append('gender', form.gender);
      body.append('shareConsent', consent);

      await apiClient.post('/member/resume', body);
      setFile(null);
      setSuccess('Resume uploaded.');
      await load();
    } catch (err) {
      setError(err.message || 'Failed to upload your resume');
    } finally {
      setSaving(false);
    }
  };

  const setSharing = async (shareConsent) => {
    if (!shareConsent && resume?.assignedCount > 0) {
      const ok = window.confirm(
        `Stop sharing? Your resume will be withdrawn from ${resume.assignedCount} partner organization(s) immediately.`
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      const data = await apiClient.patch('/member/resume/consent', { shareConsent });
      setResume(data.resume);
      setSuccess(shareConsent ? 'Sharing enabled.' : 'Sharing stopped and existing shares withdrawn.');
    } catch (err) {
      setError(err.message || 'Failed to update your sharing preference');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <Card variant="outlined" sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Talent Partner Network resume
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Optional. UConsulting shares resumes with partner organizations looking for interns and
          early-career hires. Nothing is shared unless you tick the box below, and you can withdraw
          at any time.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
            {success}
          </Alert>
        )}

        {resume && (
          <>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip label={resume.originalName} onClick={() => setPreviewOpen(true)} />
              <Chip
                size="small"
                color={resume.shareConsent ? 'success' : 'default'}
                label={resume.shareConsent ? 'Shared with partners' : 'Not shared'}
              />
              {resume.shareConsent && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${resume.assignedCount} organization(s) can see it`}
                />
              )}
            </Stack>

            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              {resume.shareConsent ? (
                <Button size="small" color="error" disabled={saving} onClick={() => setSharing(false)}>
                  Stop sharing
                </Button>
              ) : (
                <Button size="small" variant="contained" disabled={saving} onClick={() => setSharing(true)}>
                  Share with partners
                </Button>
              )}
              <Button size="small" onClick={() => setPreviewOpen(true)}>
                Preview
              </Button>
            </Stack>

            <Divider sx={{ my: 3 }} />
            <Typography variant="subtitle2" gutterBottom>
              Replace your resume
            </Typography>
          </>
        )}

        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <FormControl fullWidth size="small" required>
              <InputLabel id="member-major1-label">Major</InputLabel>
              <Select
                labelId="member-major1-label"
                id="member-major1"
                value={form.major1}
                label="Major"
                onChange={(e) => setForm({ ...form, major1: e.target.value })}
              >
                {MAJOR_OPTIONS.map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
                <MenuItem value={OTHER_MAJOR}>Other</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          {form.major1 === OTHER_MAJOR && (
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                size="small"
                required
                label="Your major"
                value={major1Other}
                onChange={(e) => setMajor1Other(e.target.value)}
              />
            </Grid>
          )}
          <Grid size={{ xs: 12, sm: 6 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="member-major2-label">Second major (optional)</InputLabel>
              <Select
                labelId="member-major2-label"
                id="member-major2"
                value={form.major2}
                label="Second major (optional)"
                onChange={(e) => setForm({ ...form, major2: e.target.value })}
              >
                <MenuItem value="">None</MenuItem>
                {MAJOR_OPTIONS.map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
                <MenuItem value={OTHER_MAJOR}>Other</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          {form.major2 === OTHER_MAJOR && (
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                size="small"
                required
                label="Your second major"
                value={major2Other}
                onChange={(e) => setMajor2Other(e.target.value)}
              />
            </Grid>
          )}
          <Grid size={{ xs: 12, sm: 6 }}>
            <FormControl fullWidth size="small" required>
              <InputLabel id="member-graduation-year-label">Graduation year</InputLabel>
              <Select
                labelId="member-graduation-year-label"
                id="member-graduation-year"
                value={form.graduationYear}
                label="Graduation year"
                onChange={(e) => setForm({ ...form, graduationYear: e.target.value })}
              >
                {GRADUATION_YEARS.map((year) => (
                  <MenuItem key={year} value={year}>{year}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="member-gender-label">Gender (optional)</InputLabel>
              <Select
                labelId="member-gender-label"
                id="member-gender"
                value={form.gender}
                label="Gender (optional)"
                onChange={(e) => setForm({ ...form, gender: e.target.value })}
              >
                <MenuItem value="">Prefer not to say</MenuItem>
                {genders.map((g) => (
                  <MenuItem key={g} value={g}>
                    {g}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
        </Grid>

        <Stack spacing={2} sx={{ mt: 3 }}>
          <Box>
            <FormLabel required>Resume (PDF)</FormLabel>
            <Box sx={{ mt: 1 }}>
              <Button variant="outlined" component="label" size="small">
                {file ? 'Choose a different file' : 'Choose PDF'}
                <input
                  hidden
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </Button>
              {file && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {file.name}
                </Typography>
              )}
            </Box>
          </Box>

          {/* Asked as a required yes/no with neither preselected, matching the
              candidate onboarding form. A checkbox cannot tell "no" apart from
              "did not answer", and reading the second as permission is how a
              resume reaches a company on an answer nobody gave. */}
          <FormControl required>
            <FormLabel>
              May we share your resume with UConsulting&apos;s partner organizations?
            </FormLabel>
            <RadioGroup
              row
              value={consent}
              onChange={(e) => setConsent(e.target.value)}
              sx={{ mt: 0.5 }}
            >
              <FormControlLabel value="true" control={<Radio size="small" />} label="Yes" />
              <FormControlLabel value="false" control={<Radio size="small" />} label="No" />
            </RadioGroup>
          </FormControl>

          <Button
            variant="contained"
            sx={{ alignSelf: 'flex-start' }}
            disabled={!file || saving}
            onClick={upload}
          >
            {resume ? 'Replace resume' : 'Upload resume'}
          </Button>
        </Stack>
      </CardContent>

      {previewOpen && (
        <DocumentPreviewModal
          src="/api/member/resume/pdf"
          kind="pdf"
          title="Your resume"
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </Card>
  );
};

export default MemberResumeCard;
