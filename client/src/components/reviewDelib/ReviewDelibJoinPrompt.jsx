import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Fab,
  Grow,
  List,
  ListItemButton,
  ListItemText,
  Typography
} from '@mui/material';
import GroupsIcon from '@mui/icons-material/Groups';

// "Your review team's deliberation has started", and the pill that stays in the
// corner until it ends. It sits above the live vote's pill, so both fit.
//
// A member only ever sees their own team's session. An admin can see several
// at once (teams run in parallel), so the prompt lists them.

const pulse = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  bgcolor: 'warning.main',
  flexShrink: 0,
  animation: 'reviewDelibPulse 1.6s ease-in-out infinite',
  '@keyframes reviewDelibPulse': {
    '0%': { boxShadow: '0 0 0 0 rgba(237, 108, 2, 0.6)' },
    '70%': { boxShadow: '0 0 0 10px rgba(237, 108, 2, 0)' },
    '100%': { boxShadow: '0 0 0 0 rgba(237, 108, 2, 0)' }
  },
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
};

export default function ReviewDelibJoinPrompt({ sessions, promptOpen, isAdmin, onJoin, onDismiss, onReopen }) {
  const [first] = sessions;
  const single = sessions.length === 1;
  const title = single
    ? isAdmin ? `${first.groupName} deliberation started` : 'Your review team deliberation has started'
    : isAdmin ? `${sessions.length} review team deliberations are running` : `${sessions.length} of your review teams are deliberating`;

  return (
    <>
      <Dialog
        open={promptOpen}
        onClose={onDismiss}
        TransitionComponent={Grow}
        maxWidth="xs"
        fullWidth
        aria-labelledby="review-delib-prompt-title"
      >
        <DialogTitle id="review-delib-prompt-title" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={pulse} aria-hidden="true" />
          {title}
        </DialogTitle>
        <DialogContent>
          {single ? (
            <>
              <Typography variant="body1" gutterBottom>
                {isAdmin
                  ? 'Join to go over the team’s grades with them, or run it.'
                  : 'Join to go over your team’s grades with the admins.'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {[first.groupName, first.createdByName ? `started by ${first.createdByName}` : null].filter(Boolean).join(' · ')}
              </Typography>
            </>
          ) : (
            <List dense disablePadding>
              {sessions.map((session) => (
                <ListItemButton key={session.id} onClick={() => onJoin(session)}>
                  <ListItemText
                    primary={session.groupName}
                    secondary={session.createdByName ? `Started by ${session.createdByName}` : null}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onDismiss}>Not now</Button>
          {single && (
            <Button variant="contained" startIcon={<GroupsIcon />} onClick={() => onJoin(first)} autoFocus>
              Join deliberation
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {!promptOpen && (
        <Fab
          variant="extended"
          color="warning"
          // With several running, the pill reopens the list rather than picking one.
          onClick={single ? () => onJoin(first) : onReopen}
          aria-label={single
            ? first.joined ? 'Return to the review team deliberation' : 'Join the review team deliberation'
            : 'Show the review team deliberations that are running'}
          sx={{
            position: 'fixed',
            right: 24,
            bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))',
            zIndex: (theme) => theme.zIndex.snackbar,
            gap: 1.25,
            textTransform: 'none',
            fontWeight: 600
          }}
        >
          <GroupsIcon />
          {!single
            ? `${sessions.length} delibs running`
            : first.joined ? `Back to ${first.groupName}` : `Join ${first.groupName} delib`}
        </Fab>
      )}
    </>
  );
}
