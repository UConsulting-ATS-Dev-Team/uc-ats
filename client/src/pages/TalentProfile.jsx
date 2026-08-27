import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Container,
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
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import UConsultingLogo from '../components/UConsultingLogo';

// The whole external talent portal in one page: who you are, your resume, and
// whether partner organizations may see it.
//
// It is one page rather than three because there is only ever one of each, and
// the state that matters - verified or not, shared or not - is easier to read
// when it is all visible at once.

const emptyResumeForm = { major1: '', major2: '', graduationYear: '', gender: '' };

const TalentProfile = () => {
  const { user, logout, refreshUser } = useAuth();

  const [profile, setProfile] = useState(null);
  const [resume, setResume] = useState(null);
  const [genders, setGenders] = useState([]);

  const [profileForm, setProfileForm] = useState({ fullName: '', graduationYear: '' });
  const [resumeForm, setResumeForm] = useState(emptyResumeForm);
  const [file, setFile] = useState(null);
  const [consent, setConsent] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [resent, setResent] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get('/talent/me');
      setProfile(data.profile);
      setResume(data.resume);
      setGenders(data.genders || []);
      setProfileForm({
        fullName: data.profile.fullName || '',
        graduationYear: data.profile.graduationYear || '',
      });
      setResumeForm({
        major1: data.resume?.major1 || '',
        major2: data.resume?.major2 || '',
        // Falls back to the year given at signup so the form is prefilled on a
        // first upload rather than asking for it a second time.
        graduationYear: data.resume?.graduationYear || data.profile.graduationYear || '',
        gender: data.resume?.gender || '',
      });
    } catch (err) {
      setError(err.message || 'Failed to load your profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveProfile = async () => {
    setSaving(true);
    setError('');
    try {
      const data = await apiClient.patch('/talent/profile', profileForm);
      setProfile(data.profile);
      setSuccess('Profile saved.');
      await refreshUser();
    } catch (err) {
      setError(err.message || 'Failed to save your profile');
    } finally {
      setSaving(false);
    }
  };

  const upload = async () => {
    if (!file) return;
    setSaving(true);
    setError('');
    try {
      const body = new FormData();
      body.append('resume', file);
      body.append('major1', resumeForm.major1);
      body.append('major2', resumeForm.major2);
      body.append('graduationYear', resumeForm.graduationYear);
      body.append('gender', resumeForm.gender);
      body.append('shareConsent', String(consent));

      await apiClient.post('/talent/resume', body);
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
    setError('');
    try {
      const data = await apiClient.patch('/talent/resume/consent', { shareConsent });
      setResume(data.resume);
      setSuccess(
        shareConsent ? 'Sharing enabled.' : 'Sharing stopped and existing shares withdrawn.'
      );
    } catch (err) {
      setError(err.message || 'Failed to update your sharing preference');
    } finally {
      setSaving(false);
    }
  };

  const removeResume = async () => {
    const ok = window.confirm(
      resume?.assignedCount > 0
        ? `Remove your resume? It will be withdrawn from ${resume.assignedCount} partner organization(s) immediately.`
        : 'Remove your resume?'
    );
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      await apiClient.delete('/talent/resume');
      setSuccess('Resume removed.');
      await load();
    } catch (err) {
      setError(err.message || 'Failed to remove your resume');
    } finally {
      setSaving(false);
    }
  };

  const resendVerification = async () => {
    setError('');
    try {
      await apiClient.post('/auth/resend-verification', { email: profile?.email || user?.email });
      setResent(true);
    } catch (err) {
      setError(err.message || 'Failed to resend the verification email.');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const verified = Boolean(profile?.emailVerified);

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: 'background.default', py: 4 }}>
      <Container maxWidth="md">
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 3 }}
          spacing={2}
        >
          <Stack direction="row" alignItems="center" spacing={2}>
            <UConsultingLogo />
            <Box>
              <Typography variant="h5" component="h1">
                Talent Network profile
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {profile?.email}
              </Typography>
            </Box>
          </Stack>
          <Button size="small" onClick={logout}>
            Sign out
          </Button>
        </Stack>

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

        {!verified && (
          <Alert
            severity="warning"
            sx={{ mb: 3 }}
            action={
              resent ? null : (
                <Button color="inherit" size="small" onClick={resendVerification}>
                  Resend
                </Button>
              )
            }
          >
            {resent
              ? 'A new verification link is on its way.'
              : `Check ${profile?.email} for a verification link. You can upload a resume once your UCLA email is confirmed.`}
          </Alert>
        )}

        {/* ----------------------------------------------------------------- */}
        <Card variant="outlined" sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Your details
            </Typography>
            <Grid container spacing={2} sx={{ mt: 0 }}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  size="small"
                  required
                  label="Full name"
                  value={profileForm.fullName}
                  onChange={(e) => setProfileForm({ ...profileForm, fullName: e.target.value })}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  size="small"
                  required
                  label="Graduation year"
                  placeholder="2027"
                  value={profileForm.graduationYear}
                  onChange={(e) =>
                    setProfileForm({ ...profileForm, graduationYear: e.target.value })
                  }
                />
              </Grid>
            </Grid>
            <Button
              variant="outlined"
              size="small"
              sx={{ mt: 2 }}
              disabled={saving}
              onClick={saveProfile}
            >
              Save details
            </Button>
          </CardContent>
        </Card>

        {/* ----------------------------------------------------------------- */}
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Your resume
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              UConsulting shares resumes with partner organizations looking for interns and
              early-career hires. Nothing is shared unless you tick the box below, and you can
              withdraw at any time.
            </Typography>

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

                <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
                  {resume.shareConsent ? (
                    <Button
                      size="small"
                      color="error"
                      disabled={saving}
                      onClick={() => setSharing(false)}
                    >
                      Stop sharing
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      variant="contained"
                      disabled={saving || !verified}
                      onClick={() => setSharing(true)}
                    >
                      Share with partners
                    </Button>
                  )}
                  <Button size="small" onClick={() => setPreviewOpen(true)}>
                    Preview
                  </Button>
                  <Button size="small" color="error" disabled={saving} onClick={removeResume}>
                    Remove
                  </Button>
                </Stack>

                <Divider sx={{ my: 3 }} />
                <Typography variant="subtitle2" gutterBottom>
                  Replace your resume
                </Typography>
              </>
            )}

            <Grid container spacing={2} sx={{ mt: 0 }}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  size="small"
                  required
                  label="Major"
                  value={resumeForm.major1}
                  onChange={(e) => setResumeForm({ ...resumeForm, major1: e.target.value })}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  size="small"
                  label="Second major (optional)"
                  value={resumeForm.major2}
                  onChange={(e) => setResumeForm({ ...resumeForm, major2: e.target.value })}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  size="small"
                  required
                  label="Graduation year"
                  placeholder="2027"
                  value={resumeForm.graduationYear}
                  onChange={(e) =>
                    setResumeForm({ ...resumeForm, graduationYear: e.target.value })
                  }
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>Gender (optional)</InputLabel>
                  <Select
                    value={resumeForm.gender}
                    label="Gender (optional)"
                    onChange={(e) => setResumeForm({ ...resumeForm, gender: e.target.value })}
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
              <Button
                variant="outlined"
                component="label"
                size="small"
                disabled={!verified}
                sx={{ alignSelf: 'flex-start' }}
              >
                {file ? file.name : 'Choose PDF'}
                <input
                  hidden
                  type="file"
                  accept="application/pdf"
                  // Disabled on the input as well as the Button. `component="label"`
                  // renders a <label>, and a disabled MUI label still forwards a
                  // click to the input inside it - so without this the file
                  // picker opens for an unverified account and the upload fails
                  // later, with a 403 instead of the banner already on screen.
                  disabled={!verified}
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </Button>

              <FormControlLabel
                control={
                  <Checkbox
                    checked={consent}
                    disabled={!verified}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                }
                label="My resume may be shared with UConsulting's partner organizations"
              />

              <Button
                variant="contained"
                sx={{ alignSelf: 'flex-start' }}
                disabled={!file || saving || !verified}
                onClick={upload}
              >
                {resume ? 'Replace resume' : 'Upload resume'}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Container>

      {previewOpen && (
        <DocumentPreviewModal
          src="/api/talent/resume/pdf"
          kind="pdf"
          title="Your resume"
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </Box>
  );
};

export default TalentProfile;
