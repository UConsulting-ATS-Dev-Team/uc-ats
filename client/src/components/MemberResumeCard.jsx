import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import apiClient from '../utils/api';
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
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get('/member/resume');
      setResume(data.resume);
      setGenders(data.genders || []);
      if (data.resume) {
        setForm({
          major1: data.resume.major1 || '',
          major2: data.resume.major2 || '',
          graduationYear: data.resume.graduationYear || '',
          gender: data.resume.gender || '',
        });
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
    if (!file) return;
    setSaving(true);
    setError('');
    try {
      const body = new FormData();
      body.append('resume', file);
      body.append('major1', form.major1);
      body.append('major2', form.major2);
      body.append('graduationYear', form.graduationYear);
      body.append('gender', form.gender);
      body.append('shareConsent', String(consent));

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
            <TextField
              fullWidth
              size="small"
              required
              label="Major"
              value={form.major1}
              onChange={(e) => setForm({ ...form, major1: e.target.value })}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              size="small"
              label="Second major (optional)"
              value={form.major2}
              onChange={(e) => setForm({ ...form, major2: e.target.value })}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              size="small"
              required
              label="Graduation year"
              placeholder="2027"
              value={form.graduationYear}
              onChange={(e) => setForm({ ...form, graduationYear: e.target.value })}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Gender (optional)</InputLabel>
              <Select
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

        <Stack spacing={1} sx={{ mt: 2 }}>
          <Button variant="outlined" component="label" size="small" sx={{ alignSelf: 'flex-start' }}>
            {file ? file.name : 'Choose PDF'}
            <input
              hidden
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Button>

          <FormControlLabel
            control={<Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} />}
            label="My resume may be shared with UConsulting's partner organizations"
          />

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
