import { Box, Chip, Stack, Typography } from '@mui/material';

// What the candidate did this cycle besides apply: the events they came to and
// who referred them. Read-only, and kept to a line or two so the documents stay
// in view. A card from before these fields existed simply leaves them out.

const clampTwoLines = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden'
};

function Attendance({ attendance }) {
  const attended = attendance.attended || [];
  return (
    <Box component="section" aria-label="Events attended" sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>Events attended</Typography>
        {attended.length ? (
          <>
            {attendance.eventCount > 0 && (
              <Typography variant="body2" color="text.secondary">
                {attendance.attendedCount} of {attendance.eventCount}
              </Typography>
            )}
            {attended.map((event) => (
              <Chip key={event.id} size="small" variant="outlined" label={event.name} />
            ))}
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">No events attended</Typography>
        )}
      </Stack>
    </Box>
  );
}

function Referrals({ referrals }) {
  return (
    <Box component="section" aria-label="Referrals" sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="baseline">
        <Typography variant="body2" sx={{ fontWeight: 700, flexShrink: 0 }}>Referrals</Typography>
        {referrals.length ? (
          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
            {referrals.map((referral) => {
              const detail = [referral.relationship, referral.reason].filter(Boolean).join(' · ');
              return (
                <Typography key={referral.id} variant="body2" sx={clampTwoLines} title={detail || undefined} data-no-track>
                  <Box component="span" sx={{ fontWeight: 600 }}>{referral.referrerName}</Box>
                  {detail && <Box component="span" sx={{ color: 'text.secondary' }}>{` · ${detail}`}</Box>}
                </Typography>
              );
            })}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">No referrals</Typography>
        )}
      </Stack>
    </Box>
  );
}

export default function CandidateParticipation({ card }) {
  const { attendance, referrals } = card;
  if (!attendance && !Array.isArray(referrals)) return null;
  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={{ xs: 1, md: 3 }} sx={{ mb: 3 }}>
      {attendance && <Attendance attendance={attendance} />}
      {Array.isArray(referrals) && <Referrals referrals={referrals} />}
    </Stack>
  );
}
