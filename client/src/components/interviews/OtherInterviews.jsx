import React, { useEffect, useMemo, useState } from 'react';
import { Paper, Typography } from '@mui/material';
import apiClient from '../../utils/api';
import InterviewManageList from './InterviewManageList';

/**
 * This cycle's interviews that belong to no scheduling round - Deliberations,
 * mainly. The round tabs come from the scheduling overview, which only knows
 * the rounds candidates book into, so without this they would have nowhere on
 * the page to be edited, run or deleted.
 *
 * Renders nothing when there are none, which is the usual case.
 */
/** `roundInterviewIds` is a comma-joined string of the interviews the round tabs already show. */
export default function OtherInterviews({ cycleId, roundInterviewIds, refreshKey, onChanged }) {
  const [others, setOthers] = useState(null);

  // Passed as a joined string, so a parent re-render with the same interviews
  // is not a refetch.
  const known = useMemo(() => new Set((roundInterviewIds || '').split(',').filter(Boolean)), [roundInterviewIds]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiClient.get('/admin/interviews');
        const extra = (list || []).filter((i) => (!cycleId || i.cycleId === cycleId) && !known.has(i.id));
        // The overview has no sessions for these, so each one's roster is
        // read here. There are rarely more than one or two.
        const rosters = await Promise.all(
          extra.map((i) =>
            apiClient
              .get(`/admin/interviews/${i.id}/roster`)
              .then((roster) => (roster?.slots ?? []).map((slot) => ({ ...slot, interviewId: i.id })))
              .catch(() => [])
          )
        );
        if (!cancelled) setOthers({ interviews: extra, slots: rosters.flat() });
      } catch {
        if (!cancelled) setOthers(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cycleId, known, refreshKey]);

  if (!others || others.interviews.length === 0) return null;

  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 3 }}>
      <Typography variant="subtitle2">Other interviews this cycle</Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        Not part of a round candidates book into, such as deliberations.
      </Typography>
      <InterviewManageList round={others} onChanged={onChanged} />
    </Paper>
  );
}
