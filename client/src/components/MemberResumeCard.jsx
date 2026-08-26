import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
//
// Details and the PDF are edited separately on purpose. Correcting a major or a
// graduation year is not a new document: it saves in place and reaches the
// partners already holding the resume, where replacing the file supersedes it
// and leaves their copy alone.

const emptyForm = { major1: '', major2: '', graduationYear: '', gender: '' };

const formFrom = (resume) =>
  resume
    ? {
        major1: resume.major1 || '',
        major2: resume.major2 || '',
        graduationYear: resume.graduationYear || '',
        gender: resume.gender || '',
      }
    : emptyForm;

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

  const applyResume = useCallback((next) => {
    setResume(next);
    setForm(formFrom(next));
    // The checkbox reflects the answer on file rather than defaulting to
    // unticked. Defaulting to false made "replace my PDF" look like a
    // withdrawal to anyone who read the form before submitting it.
    setConsent(Boolean(next?.shareConsent));
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get('/member/resume');
      setGenders(data.genders || []);
      applyResume(data.resume);
    } catch (err) {
      setError(err.message || 'Failed to load your resume');
    } finally {
      setLoading(false);
    }
  }, [applyResume]);

  useEffect(() => {
    load();
  }, [load]);

  const detailsDirty = useMemo(() => {
    if (!resume) return false;
    const saved = formFrom(resume);
    return Object.keys(emptyForm).some((key) => form[key] !== saved[key]);
  }, [form, resume]);

  const run = async (action, message) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await action();
      if (message) setSuccess(message);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  const saveDetails = () =>
    run(async () => {
      const data = await apiClient.patch('/member/resume', form);
      applyResume(data.resume);
    }, 'Details saved.');

  const upload = () => {
    if (!file) return;
    return run(async () => {
      const body = new FormData();
      body.append('resume', file);
      body.append('major1', form.major1);
      body.append('major2', form.major2);
      body.append('graduationYear', form.graduationYear);
      body.append('gender', form.gender);
      body.append('shareConsent', String(consent));

      const data = await apiClient.post('/member/resume', body);
      setFile(null);
      applyResume(data.resume);
    }, resume ? 'Resume replaced.' : 'Resume uploaded.');
  };

  const setSharing = (shareConsent) => {
    if (!shareConsent && resume?.assignedCount > 0) {
      const ok = window.confirm(
        `Stop sharing? Your resume will be withdrawn from ${resume.assignedCount} partner organization(s) immediately.`
      );
      if (!ok) return;
    }
    return run(async () => {
      const data = await apiClient.patch('/member/resume/consent', { shareConsent });
      applyResume(data.resume);
    }, shareConsent ? 'Sharing enabled.' : 'Sharing stopped and existing shares withdrawn.');
  };

  const remove = () => {
    const warning =
      resume?.assignedCount > 0
        ? `Remove your resume? It will be withdrawn from ${resume.assignedCount} partner organization(s) immediately.`
        : 'Remove your resume from the Talent Partner Network?';
    if (!window.confirm(warning)) return;
    return run(async () => {
      await apiClient.delete('/member/resume');
      applyResume(null);
      setFile(null);
    }, 'Resume removed.');
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
              {resume.assignedCount > 0 && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${resume.assignedCount} organization(s) can see it`}
                />
              )}
            </Stack>

            <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
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
              <Button size="small" color="error" disabled={saving} onClick={remove}>
                Remove resume
              </Button>
            </Stack>

            <Divider sx={{ my: 3 }} />
          </>
        )}

        <Typography variant="subtitle2" gutterBottom>
          Your details
        </Typography>
        {resume && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Saved on its own, without re-uploading. Corrections reach partners who already have your
            resume.
          </Typography>
        )}

        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid item xs={12} sm={6}>
            <TextField
              fullWidth
              size="small"
              required
              label="Major"
              value={form.major1}
              inputProps={{ 'data-testid': 'member-resume-major1' }}
              onChange={(e) => setForm({ ...form, major1: e.target.value })}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              fullWidth
              size="small"
              label="Second major (optional)"
              value={form.major2}
              onChange={(e) => setForm({ ...form, major2: e.target.value })}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              fullWidth
              size="small"
              required
              label="Graduation year"
              placeholder="2027"
              value={form.graduationYear}
              inputProps={{ 'data-testid': 'member-resume-graduation-year' }}
              onChange={(e) => setForm({ ...form, graduationYear: e.target.value })}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
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

        {resume && (
          <Stack direction="row" spacing={1} sx={{ mt: 2 }} alignItems="center">
            <Button
              variant="contained"
              size="small"
              disabled={!detailsDirty || saving}
              onClick={saveDetails}
              data-testid="member-resume-save-details"
            >
              Save details
            </Button>
            <Button
              size="small"
              disabled={!detailsDirty || saving}
              onClick={() => setForm(formFrom(resume))}
            >
              Discard changes
            </Button>
          </Stack>
        )}

        <Divider sx={{ my: 3 }} />

        <Typography variant="subtitle2" gutterBottom>
          {resume ? 'Replace your PDF' : 'Upload your resume'}
        </Typography>
        {resume && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Partners who already have your resume keep the version they were given.
          </Typography>
        )}

        <Stack spacing={1} sx={{ mt: 1 }}>
          <Button variant="outlined" component="label" size="small" sx={{ alignSelf: 'flex-start' }}>
            {file ? file.name : 'Choose PDF'}
            <input
              hidden
              type="file"
              accept="application/pdf"
              data-testid="member-resume-file"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Button>

          <FormControlLabel
            control={
              <Checkbox
                checked={consent}
                inputProps={{ 'data-testid': 'member-resume-consent' }}
                onChange={(e) => setConsent(e.target.checked)}
              />
            }
            label="My resume may be shared with UConsulting's partner organizations"
          />

          <Button
            variant={resume ? 'outlined' : 'contained'}
            sx={{ alignSelf: 'flex-start' }}
            disabled={!file || saving}
            onClick={upload}
            data-testid="member-resume-upload"
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
