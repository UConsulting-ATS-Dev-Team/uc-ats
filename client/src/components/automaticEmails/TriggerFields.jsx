import React from 'react';
import { MenuItem, Stack, TextField } from '@mui/material';

/**
 * The fields for one trigger's configuration. Offsets are stored in hours,
 * signed (negative is before); they are edited as an amount, a unit and a
 * direction, which is how people say it ("2 days before").
 */

const STATUS_LABELS = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  WAITLISTED: 'Waitlisted',
};

function splitOffset(hours = -24) {
  const abs = Math.abs(hours);
  const unit = abs !== 0 && abs % 24 === 0 ? 'days' : 'hours';
  return { amount: unit === 'days' ? abs / 24 : abs, unit, direction: hours > 0 ? 'after' : 'before' };
}

function joinOffset({ amount, unit, direction }) {
  const n = Math.max(0, Math.round(Number(amount) || 0));
  const hours = unit === 'days' ? n * 24 : n;
  return direction === 'after' ? hours : -hours;
}

function OffsetFields({ hours, onChange, anchor }) {
  const parts = splitOffset(hours);
  const set = (patch) => onChange(joinOffset({ ...parts, ...patch }));
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
      <TextField
        type="number"
        size="small"
        label="How long"
        value={parts.amount}
        onChange={(e) => set({ amount: e.target.value })}
        slotProps={{ htmlInput: { min: 0, 'aria-label': 'How long' } }}
        sx={{ width: 110 }}
      />
      <TextField select size="small" label="Unit" value={parts.unit} onChange={(e) => set({ unit: e.target.value })} sx={{ width: 110 }}>
        <MenuItem value="hours">{Number(parts.amount) === 1 ? 'hour' : 'hours'}</MenuItem>
        <MenuItem value="days">{Number(parts.amount) === 1 ? 'day' : 'days'}</MenuItem>
      </TextField>
      <TextField select size="small" label="When" value={parts.direction} onChange={(e) => set({ direction: e.target.value })} sx={{ width: 120 }}>
        <MenuItem value="before">before</MenuItem>
        <MenuItem value="after">after</MenuItem>
      </TextField>
      <span>{anchor}</span>
    </Stack>
  );
}

export default function TriggerFields({ trigger, config, options, onChange }) {
  const set = (patch) => onChange({ ...config, ...patch });

  switch (trigger) {
    case 'APPLICATION_STATUS':
      return (
        <TextField select fullWidth label="Status" value={config.status ?? ''} onChange={(e) => set({ status: e.target.value })}
          helperText="Only applications that reach this status after you turn the email on are emailed.">
          {(options.statuses ?? []).map((s) => (
            <MenuItem key={s} value={s}>{STATUS_LABELS[s] ?? s}</MenuItem>
          ))}
        </TextField>
      );
    case 'RECORD_CREATED':
      return (
        <TextField select fullWidth label="When" value={config.record ?? ''} onChange={(e) => set({ record: e.target.value })}>
          {(options.records ?? []).map((r) => (
            <MenuItem key={r.id} value={r.id}>{r.label}</MenuItem>
          ))}
        </TextField>
      );
    case 'EVENT_TIME':
      return <OffsetFields hours={config.offsetHours ?? -24} onChange={(offsetHours) => set({ offsetHours })} anchor="the event starts" />;
    case 'INTERVIEW_TIME':
      return <OffsetFields hours={config.offsetHours ?? -24} onChange={(offsetHours) => set({ offsetHours })} anchor="their interview starts" />;
    case 'CYCLE_DATE':
      return (
        <Stack spacing={2}>
          <TextField select fullWidth label="Cycle date" value={config.field ?? ''} onChange={(e) => set({ field: e.target.value })}>
            {(options.cycleDates ?? []).map((d) => (
              <MenuItem key={d.id} value={d.id}>{d.label}</MenuItem>
            ))}
          </TextField>
          <OffsetFields hours={config.offsetHours ?? -72} onChange={(offsetHours) => set({ offsetHours })} anchor="that date" />
          <TextField
            select
            fullWidth
            label="Send to (saved audience)"
            value={config.savedAudienceId ?? ''}
            onChange={(e) => set({ savedAudienceId: e.target.value })}
            helperText={
              (options.savedAudiences ?? []).length
                ? 'Worked out on the day, so it reaches whoever matches then. Build audiences in Master Communications.'
                : 'No saved audiences yet. Build one in Master Communications first.'
            }
          >
            {(options.savedAudiences ?? []).map((a) => (
              <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>
            ))}
          </TextField>
        </Stack>
      );
    default:
      return null;
  }
}

export const defaultConfigFor = (trigger) =>
  ({
    APPLICATION_STATUS: { status: 'WAITLISTED' },
    RECORD_CREATED: { record: 'APPLICATION' },
    EVENT_TIME: { offsetHours: -24 },
    INTERVIEW_TIME: { offsetHours: -24 },
    CYCLE_DATE: { field: 'applicationDeadline', offsetHours: -72, savedAudienceId: '' },
  })[trigger] ?? {};
