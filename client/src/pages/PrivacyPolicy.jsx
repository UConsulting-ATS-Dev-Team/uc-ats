import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Container, Divider, Link, Paper, Stack, Typography } from '@mui/material';
import UConsultingLogo from '../components/UConsultingLogo';

// Public and unauthenticated on purpose. Google will not publish an OAuth
// consent screen whose privacy policy URL sits behind a login, and neither
// would anyone deciding whether to hand us their resume.
//
// Written against what the code actually stores - see the Application and
// ExternalResume models - rather than from a template. If the data the app
// collects changes, this page is part of the change.

const UPDATED = 'September 14, 2026';
const CONTACT = 'uconsultingla@gmail.com';

const Section = ({ title, children }) => (
  <Box sx={{ mb: 4 }}>
    <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>
      {title}
    </Typography>
    <Stack spacing={1.5}>{children}</Stack>
  </Box>
);

const Body = ({ children }) => (
  <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
    {children}
  </Typography>
);

const Bullets = ({ items }) => (
  <Box component="ul" sx={{ pl: 3, m: 0 }}>
    {items.map((item, i) => (
      <Typography
        key={i}
        component="li"
        variant="body2"
        color="text.secondary"
        sx={{ lineHeight: 1.7, mb: 0.5 }}
      >
        {item}
      </Typography>
    ))}
  </Box>
);

const PrivacyPolicy = () => (
  <Box sx={{ minHeight: '100vh', backgroundColor: 'background.default', py: 5 }}>
    <Container maxWidth="md">
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 3 }}>
        <UConsultingLogo />
        <Box>
          <Typography variant="h5" component="h1">
            Privacy Policy
          </Typography>
          <Typography variant="body2" color="text.secondary">
            UConsulting Application Tracking System · Last updated {UPDATED}
          </Typography>
        </Box>
      </Stack>

      <Paper sx={{ p: { xs: 3, sm: 4 } }}>
        <Section title="Who this covers">
          <Body>
            This policy applies to the UConsulting Application Tracking System at
            uconsultingats.com, used by UConsulting, a student organization at UCLA, to run its
            recruitment process and its Talent Partner Network. It covers applicants, members of
            the organization, students who join the Talent Network, and partner companies who
            receive resumes through it.
          </Body>
        </Section>

        <Section title="What we collect">
          <Body>
            <strong>Account information.</strong> Your name, email address, graduation year, and
            UCLA student ID. If you set a password we store it hashed, never in readable form. If
            you sign in with Google we store your Google account identifier instead, and you may
            have no password at all.
          </Body>
          <Body>
            <strong>Application information</strong>, if you apply to UConsulting. This is
            submitted through a Google Form and includes your phone number, major or majors,
            cumulative and major GPA, whether you are a transfer student, whether you are a
            first-generation college student, gender if you choose to give it, and the documents
            you attach — resume, headshot, and where the form asks for them, a cover letter and a
            video.
          </Body>
          <Body>
            <strong>Recruitment records.</strong> If you go through our process we record
            interview scores, written evaluations, reviewer comments, event attendance, and the
            decisions made at each round.
          </Body>
          <Body>
            <strong>Talent Network information</strong>, if you join it. Your resume, major or
            majors, graduation year, and gender if you choose to give it.
          </Body>
          <Body>
            <strong>Technical information.</strong> Ordinary server logs, and a record of which
            partner companies opened which resumes.
          </Body>
        </Section>

        <Section title="Signing in with Google">
          <Body>
            If you use “Continue with Google,” Google tells us your Google account identifier,
            your email address, your name, and whether Google has verified that email address. We
            request no other access: we cannot read your Gmail, your Google Drive, your contacts,
            or your calendar, and we do not take your Google profile photo.
          </Body>
          <Body>
            We use that information only to sign you in and to create or identify your account.
            If the email address matches an account you already have here, we connect the two so
            that you keep the account you already had rather than getting a second one. We do not
            sell it, and we do not use it for advertising.
          </Body>
        </Section>

        <Section title="How we use it">
          <Bullets
            items={[
              'To run recruitment: reviewing applications, scheduling and conducting interviews, and reaching decisions.',
              'To contact you about your application, interviews, events, and account — including verifying your email address and resetting your password.',
              'To operate the Talent Partner Network, if you have opted in.',
              'To keep the system working and secure.'
            ]}
          />
          <Body>
            We do not sell personal information, and we do not use it for advertising or
            automated decision-making without a person involved.
          </Body>
        </Section>

        <Section title="Who we share it with">
          <Body>
            <strong>Partner companies, only if you consent.</strong> If you opt in to the Talent
            Partner Network, UConsulting may share your resume and the details attached to it
            with partner employers. This is off unless you turn it on, you can withdraw it at any
            time from your profile, and withdrawing it stops further sharing. Resumes already
            delivered to a partner cannot be recalled from them, though we can and do revoke
            their continued access.
          </Body>
          <Body>
            <strong>People inside UConsulting.</strong> Members involved in recruitment see
            application materials and evaluations for the purpose of reviewing them. Some records
            are sealed once a decision is final, and opening them requires a separate executive
            password, which is logged.
          </Body>
          <Body>
            <strong>Service providers who run the infrastructure.</strong> Google (sign-in,
            Forms, and Drive for uploaded documents), our database and file hosting provider, our
            application hosting providers, and our email provider. They process this information
            on our behalf, not for their own purposes.
          </Body>
          <Body>
            We may also disclose information where the law requires it.
          </Body>
        </Section>

        <Section title="Your choices">
          <Bullets
            items={[
              'See and correct your own profile from your account at any time.',
              'Turn Talent Network sharing on or off yourself, and delete a resume you have uploaded.',
              'Ask us for a copy of what we hold about you, or ask us to delete it, by writing to the address below.',
              'Disconnect Google sign-in by setting a password through “Forgot password.”'
            ]}
          />
          <Body>
            Deleting your recruitment record may not be possible while a recruitment cycle you
            are part of is still running, and we keep what we need in order to make the process
            fair and reviewable. We will tell you if that applies to your request.
          </Body>
        </Section>

        <Section title="How long we keep it">
          <Body>
            Account and recruitment records are kept for as long as the organization needs them
            to run and review its recruitment, and records of past cycles are retained for
            continuity between years. Talent Network resumes are kept until you delete them or
            withdraw consent. Ask us at the address below if you want yours removed sooner.
          </Body>
        </Section>

        <Section title="Security">
          <Body>
            Access is restricted by role, passwords are stored hashed, uploaded documents are
            held in access-controlled storage, sealed records require a separate password to
            open, and partner access to resumes is logged and revocable. No system is perfectly
            secure, and we do not claim otherwise.
          </Body>
        </Section>

        <Section title="Students and age">
          <Body>
            This system is intended for UCLA students and for the companies UConsulting works
            with. It is not directed at children, and we do not knowingly collect information
            from anyone under 13.
          </Body>
        </Section>

        <Section title="Changes">
          <Body>
            If this policy changes we will update the date at the top of this page. Significant
            changes to how we share information will be communicated to affected users.
          </Body>
        </Section>

        <Divider sx={{ my: 3 }} />

        <Section title="Contact">
          <Body>
            Questions, access requests, and deletion requests go to{' '}
            <Link href={`mailto:${CONTACT}`}>{CONTACT}</Link>. UConsulting is a registered student
            organization at the University of California, Los Angeles. UConsulting is responsible
            for this system; it is not operated by the University.
          </Body>
        </Section>

        <Typography variant="body2" align="center" sx={{ mt: 4 }}>
          <Link component={RouterLink} to="/login">
            Back to sign in
          </Link>
        </Typography>
      </Paper>
    </Container>
  </Box>
);

export default PrivacyPolicy;
