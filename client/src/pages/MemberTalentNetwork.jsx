import React from 'react';
import { Box, Typography } from '@mui/material';
import MemberResumeCard from '../components/MemberResumeCard';

// The member's Talent Partner Network resume, on a page of its own.
//
// It used to sit on the dashboard, where it competed with tasks and resources
// and was easy to scroll past - which is how members ended up never answering
// the sharing question at all. Its own route means the login prompt has
// somewhere to send them, and the nav has somewhere to point.
//
// The form itself is still MemberResumeCard: it owns the upload, the consent
// toggle and the withdrawal rules, and those are the same wherever it renders.

const MemberTalentNetwork = () => (
  <Box sx={{ maxWidth: 900, mx: 'auto', p: 0 }}>
    <Box sx={{ mb: 3 }}>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, color: 'primary.dark' }}>
        Talent Partner Network
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
        UConsulting shares member resumes with partner organizations hiring interns and
        early-career candidates. Taking part is optional, and you can withdraw at any time —
        withdrawing pulls your resume back from every company it was sent to.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        If you applied to UConsulting in an earlier cycle we already have that resume, but it is
        the one you applied with. Upload a current version here so partners see your most recent
        experience.
      </Typography>
    </Box>

    <MemberResumeCard />
  </Box>
);

export default MemberTalentNetwork;
