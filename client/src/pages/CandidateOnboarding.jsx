import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  InputLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import apiClient from '../utils/api';
import UConsultingLogo from '../components/UConsultingLogo';
import { GRADUATION_YEARS } from '../utils/graduationYears';
import { markOnboardingComplete } from '../utils/onboardingStatus';
import { MAJOR_OPTIONS, OTHER_MAJOR } from '../utils/majors';
import { formatPhone, digitsOf, phoneError, gpaError } from '../utils/fieldValidation';

// The applicant profile a candidate builds when there is nothing behind their
// account.
//
// Shown only when the server says `required` - that is, no application has ever
// been filed under this student ID or email. An applicant who has applied is
// never sent here, because the application already carries everything this asks
// and asking again would invite two answers to the same question.
//
// One file: a resume. No cover letter and no video - those are scored by a
// review team inside a cycle, and there is no cycle here.

const GENDERS = ['Male', 'Female', 'Other'];

const emptyForm = {
  phoneNumber: '',
  graduationYear: '',
  cumulativeGpa: '',
  major1: '',
  major2: '',
  gender: '',
  isTransferStudent: '',
  isFirstGeneration: '',
};

const CandidateOnboarding = () => {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [resume, setResume] = useState(null);
  const [headshot, setHeadshot] = useState(null);
  const [optIn, setOptIn] = useState('');
  // Held apart from `form` because the select and the text box are two controls
  // for one answer: the select says which bucket, the text box says which major
  // when the bucket is "Other", and only one of them is ever submitted.
  const [major1Other, setMajor1Other] = useState('');
  const [major2Other, setMajor2Other] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get('/candidate/onboarding/status');
      setStatus(data);
      if (data.onboarding) {
        setForm({
          // Stored bare, displayed formatted - otherwise coming back to the
          // form shows a raw digit string where a phone number was typed.
          phoneNumber: formatPhone(data.onboarding.phoneNumber || ''),
          graduationYear: data.onboarding.graduationYear || '',
          cumulativeGpa: data.onboarding.cumulativeGpa || '',
          major1: MAJOR_OPTIONS.includes(data.onboarding.major1)
            ? data.onboarding.major1
            : (data.onboarding.major1 ? OTHER_MAJOR : ''),
          major2: MAJOR_OPTIONS.includes(data.onboarding.major2)
            ? data.onboarding.major2
            : (data.onboarding.major2 ? OTHER_MAJOR : ''),
          gender: data.onboarding.gender || '',
          isTransferStudent: String(data.onboarding.isTransferStudent ?? ''),
          isFirstGeneration: String(data.onboarding.isFirstGeneration ?? ''),
        });
      }
      if (data.onboarding && !MAJOR_OPTIONS.includes(data.onboarding.major1)) {
        setMajor1Other(data.onboarding.major1 || '');
      }
      if (data.onboarding && data.onboarding.major2 && !MAJOR_OPTIONS.includes(data.onboarding.major2)) {
        setMajor2Other(data.onboarding.major2);
      }
      setOptIn(data.completed ? String(Boolean(data.talentPool?.shared)) : '');
    } catch (err) {
      setError(err.message || 'Failed to load your onboarding status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // Shown as the person types. Both stay quiet while a field is still empty -
  // flagging a field nobody has filled in yet reads as a mistake they made.
  const phoneMessage = phoneError(form.phoneNumber);
  const gpaMessage = gpaError(form.cumulativeGpa);

  const submit = async (e) => {
    e.preventDefault();
    setError('');

    if (!resume) {
      setError('Attach your resume as a PDF.');
      return;
    }

    if (form.major1 === OTHER_MAJOR && !major1Other.trim()) {
      setError('Type your major.');
      return;
    }

    if (form.major2 === OTHER_MAJOR && !major2Other.trim()) {
      setError('Type your second major, or choose one from the list.');
      return;
    }

    if (phoneMessage || gpaMessage) {
      setError('Fix the highlighted fields before continuing.');
      return;
    }

    if (optIn !== 'true' && optIn !== 'false') {
      setError('Choose whether to share your resume with our partner companies.');
      return;
    }

    setSubmitting(true);
    try {
      const body = new FormData();
      body.append('resume', resume);
      if (headshot) body.append('headshot', headshot);
      // The sentinel never leaves this page - what is stored is the typed major,
      // so it filters alongside every other major in the pool.
      const resolved = {
        ...form,
        // The formatting is for the person reading the field; what is stored is
        // the bare digits every other phone number in the data uses.
        phoneNumber: digitsOf(form.phoneNumber),
        major1: form.major1 === OTHER_MAJOR ? major1Other.trim() : form.major1,
        major2: form.major2 === OTHER_MAJOR ? major2Other.trim() : form.major2,
      };
      Object.entries(resolved).forEach(([key, value]) => body.append(key, value));
      // Sent as the literal answer. The server treats a missing value as
      // unanswered rather than as a no, which is what keeps a skipped question
      // from quietly becoming permission to share someone's resume.
      body.append('talentPoolOptIn', optIn);

      await apiClient.post('/candidate/onboarding', body);
      // The gate would otherwise still be holding the "required" answer it read
      // before this submit, and bounce them straight back into this form.
      markOnboardingComplete();
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Failed to save your information');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Reached directly by someone who does not need it - they applied at some
  // point, so the application already answers everything below. Asking anyway
  // would invite a second, contradictory set of answers.
  if (status?.hasApplication) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Paper sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={2} alignItems="center">
            <UConsultingLogo />
            <Alert severity="success" sx={{ width: '100%' }}>
              Your profile is already complete.
            </Alert>
            <Typography variant="body2" color="text.secondary" align="center">
              We found an application on file for you, so there is nothing else to fill in.
            </Typography>
            <Button variant="contained" onClick={() => navigate('/dashboard', { replace: true })}>
              Go to my dashboard
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  // The account cannot submit until the address is proved, so the form is not
  // worth rendering - filling it in only to be refused is the worse experience.
  if (status && !status.emailVerified) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Paper sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={2} alignItems="center">
            <UConsultingLogo />
            <Alert severity="info" sx={{ width: '100%' }}>
              Check your email for a verification link before finishing your profile.
            </Alert>
            <Typography variant="body2" color="text.secondary" align="center">
              We sent it when you signed up. It expires after 24 hours.
            </Typography>
            <Button variant="outlined" onClick={() => navigate('/verify-email')}>
              I need a new link
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Paper sx={{ p: { xs: 3, sm: 4 } }}>
        <Stack spacing={1} alignItems="center" sx={{ mb: 3 }}>
          <UConsultingLogo />
          <Typography variant="h5" fontWeight={700} align="center">
            Finish your applicant profile
          </Typography>
          <Typography variant="body2" color="text.secondary" align="center">
            We could not find a previous application for you, so we need a few details before
            you can take part in recruitment.
          </Typography>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Box component="form" onSubmit={submit}>
          <Stack spacing={3}>
            <TextField
              fullWidth
              required
              label="Phone number"
              placeholder="(310) 555-0134"
              value={form.phoneNumber}
              onChange={(e) =>
                setForm((f) => ({ ...f, phoneNumber: formatPhone(e.target.value) }))
              }
              error={Boolean(phoneMessage)}
              helperText={phoneMessage}
              inputProps={{ inputMode: 'tel' }}
              autoComplete="tel"
            />

            <FormControl fullWidth required>
              <InputLabel id="graduation-year-label">Graduation year</InputLabel>
              <Select
                labelId="graduation-year-label"
                id="graduationYear"
                value={form.graduationYear}
                label="Graduation year"
                onChange={set('graduationYear')}
              >
                {GRADUATION_YEARS.map((year) => (
                  <MenuItem key={year} value={year}>{year}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              fullWidth
              required
              label="Cumulative GPA"
              placeholder="3.85"
              value={form.cumulativeGpa}
              onChange={set('cumulativeGpa')}
              error={Boolean(gpaMessage)}
              helperText={
                gpaMessage ||
                'Two decimal places. First-years with no college GPA yet: enter your high school GPA.'
              }
              inputProps={{ inputMode: 'decimal' }}
            />

            <FormControl fullWidth required>
              <InputLabel id="major1-label">Major</InputLabel>
              <Select
                labelId="major1-label"
                id="major1"
                value={form.major1}
                label="Major"
                onChange={set('major1')}
              >
                {MAJOR_OPTIONS.map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
                <MenuItem value={OTHER_MAJOR}>Other</MenuItem>
              </Select>
            </FormControl>

            {form.major1 === OTHER_MAJOR && (
              <TextField
                fullWidth
                required
                label="Your major"
                value={major1Other}
                onChange={(e) => setMajor1Other(e.target.value)}
              />
            )}

            <FormControl fullWidth>
              <InputLabel id="major2-label">Second major or minor (optional)</InputLabel>
              <Select
                labelId="major2-label"
                id="major2"
                value={form.major2}
                label="Second major or minor (optional)"
                onChange={set('major2')}
              >
                <MenuItem value="">None</MenuItem>
                {MAJOR_OPTIONS.map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
                <MenuItem value={OTHER_MAJOR}>Other</MenuItem>
              </Select>
            </FormControl>

            {form.major2 === OTHER_MAJOR && (
              <TextField
                fullWidth
                required
                label="Your second major or minor"
                value={major2Other}
                onChange={(e) => setMajor2Other(e.target.value)}
              />
            )}

            <FormControl fullWidth>
              <InputLabel id="gender-label">Gender (optional)</InputLabel>
              <Select
                labelId="gender-label"
                id="gender"
                value={form.gender}
                label="Gender (optional)"
                onChange={set('gender')}
              >
                <MenuItem value="">Prefer not to say</MenuItem>
                {GENDERS.map((g) => (
                  <MenuItem key={g} value={g}>{g}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl required>
              <FormLabel>Are you a transfer student?</FormLabel>
              <RadioGroup row value={form.isTransferStudent} onChange={set('isTransferStudent')}>
                <FormControlLabel value="true" control={<Radio />} label="Yes" />
                <FormControlLabel value="false" control={<Radio />} label="No" />
              </RadioGroup>
            </FormControl>

            <FormControl required>
              <FormLabel>Are you a first-generation college student?</FormLabel>
              <RadioGroup row value={form.isFirstGeneration} onChange={set('isFirstGeneration')}>
                <FormControlLabel value="true" control={<Radio />} label="Yes" />
                <FormControlLabel value="false" control={<Radio />} label="No" />
              </RadioGroup>
            </FormControl>

            <Divider />

            <Box>
              <FormLabel required>Resume (PDF)</FormLabel>
              <Box sx={{ mt: 1 }}>
                <Button variant="outlined" component="label">
                  {resume ? 'Choose a different file' : 'Choose file'}
                  <input
                    hidden
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setResume(e.target.files?.[0] || null)}
                  />
                </Button>
                {resume && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {resume.name}
                  </Typography>
                )}
              </Box>
            </Box>

            <Box>
              <FormLabel>Headshot (optional)</FormLabel>
              <Box sx={{ mt: 1 }}>
                <Button variant="outlined" component="label">
                  {headshot ? 'Choose a different image' : 'Choose image'}
                  <input
                    hidden
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => setHeadshot(e.target.files?.[0] || null)}
                  />
                </Button>
                {headshot && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {headshot.name}
                  </Typography>
                )}
              </Box>
            </Box>

            <Divider />

            <FormControl required>
              <FormLabel>
                May we share your resume with UConsulting&apos;s partner companies?
              </FormLabel>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Our Talent Partner Network sends resumes to companies hiring students. It has no
                bearing on your UConsulting application, and you can change this answer at any
                time - saying no later immediately withdraws your resume from any company it was
                sent to.
              </Typography>
              <RadioGroup row value={optIn} onChange={(e) => setOptIn(e.target.value)} sx={{ mt: 1 }}>
                <FormControlLabel value="true" control={<Radio />} label="Yes" />
                <FormControlLabel value="false" control={<Radio />} label="No" />
              </RadioGroup>
            </FormControl>

            <Button type="submit" variant="contained" size="large" disabled={submitting}>
              {submitting ? 'Saving...' : 'Finish setting up'}
            </Button>
          </Stack>
        </Box>
      </Paper>
    </Container>
  );
};

export default CandidateOnboarding;
