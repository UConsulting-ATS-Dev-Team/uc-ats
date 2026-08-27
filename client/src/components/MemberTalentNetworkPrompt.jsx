import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

// Asks a member to set up their Talent Partner Network resume.
//
// Shown once per login and every login until they have one, which is what makes
// it a reminder rather than a gate: a member has work to do in this app and
// blocking them from it over an optional resume would be the wrong trade. The
// once-per-login part matters just as much - re-appearing on every navigation
// would train people to dismiss it without reading.
//
// "Complete" means a resume exists, not that they said yes to sharing. Someone
// who uploaded and declined has answered the question, and continuing to ask
// would be nagging them to change a decision they already made.

// sessionStorage, not localStorage: it is cleared when the browser session ends,
// so the next login asks again. Keyed by user so two people sharing a browser
// do not inherit each other's dismissal.
const dismissKey = (userId) => `tpn_prompt_dismissed_${userId}`;

const MemberTalentNetworkPrompt = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (user?.role !== 'MEMBER' || !user?.id) return;
    // Never over the page it is asking them to visit.
    if (location.pathname === '/member/talent-network') return;

    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(dismissKey(user.id)) === '1';
    } catch {
      // Private mode, or storage disabled. Falling through means the prompt may
      // appear more than once in a session, which is better than a thrown
      // exception taking the page down with it.
    }
    if (dismissed) return;

    let cancelled = false;
    apiClient
      .get('/member/resume')
      .then((data) => {
        if (!cancelled && !data.resume) setOpen(true);
      })
      // A failed check is not a reason to interrupt someone. Staying quiet costs
      // one skipped reminder; guessing costs a modal over a broken page.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role, location.pathname]);

  const dismiss = () => {
    try {
      sessionStorage.setItem(dismissKey(user.id), '1');
    } catch {
      // See above - dismissal is a convenience, not a correctness requirement.
    }
    setOpen(false);
  };

  const go = () => {
    dismiss();
    navigate('/member/talent-network');
  };

  return (
    <Dialog open={open} onClose={dismiss} maxWidth="sm" fullWidth>
      <DialogTitle>Set up your Talent Partner Network resume</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">
          UConsulting shares member resumes with partner organizations hiring interns and
          early-career candidates. It takes a minute: upload a PDF, add your major and graduation
          year, and choose whether we may share it.
          <br />
          <br />
          If you applied in an earlier cycle we already have the resume you applied with, but it is
          out of date — please upload a current one.
          <br />
          <br />
          Taking part is optional, and you can withdraw at any time.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={dismiss}>Not now</Button>
        <Button variant="contained" onClick={go}>
          Set it up
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default MemberTalentNetworkPrompt;
