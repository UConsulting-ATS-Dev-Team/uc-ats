import React, { useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  LinearProgress,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  HourglassTop as HourglassIcon,
  MoreVert as MoreIcon,
  PersonOff as PersonOffIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { formatDay, formatTimeRange } from '../../utils/scheduleFormat';

/// A slot's heading: its own name, else its time range. Coffee chats are named
/// blocks; first round sittings are just times.
const slotHeading = (slot) => slot.label || formatTimeRange(slot.startTime, slot.endTime);

const fullName = (candidate) => `${candidate?.firstName ?? ''} ${candidate?.lastName ?? ''}`.trim() || 'Unknown';

/**
 * One card. Draggable, and also carrying a menu - the menu is not a fallback,
 * it is the accessible path, the mobile path, and the one that still works when
 * a drag lands on the wrong column.
 */
function CandidateCard({ signup, slots, currentSlotId, onMove, onRemove, dimmed, compact }) {
  const [anchor, setAnchor] = useState(null);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: signup.id,
    data: { signupId: signup.id, fromSlotId: currentSlotId },
  });

  const waiting = signup.status === 'WAITLISTED';
  const unplaced = signup.status === 'NEEDS_PLACEMENT';
  const heldElsewhere = waiting && signup.heldSeatId;

  return (
    <Paper
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      variant="outlined"
      data-testid={`candidate-${signup.id}`}
      sx={{
        p: compact ? 0.75 : 1.25,
        opacity: dimmed ? 0.25 : isDragging ? 0.4 : 1,
        cursor: 'grab',
        borderColor: unplaced ? 'error.main' : waiting ? 'warning.main' : undefined,
        transition: 'opacity 120ms',
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={0.5}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={600} noWrap>
            {fullName(signup.candidate)}
          </Typography>
          {!compact && (
            <Typography variant="caption" color="text.secondary" noWrap display="block">
              {signup.candidate?.major1}
              {signup.candidate?.graduationYear ? ` · ${signup.candidate.graduationYear}` : ''}
            </Typography>
          )}
          {/* The cross-column relationship the two-block view most needs to make
              legible: this person is queued here but has a seat over there. */}
          {heldElsewhere && (
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              icon={<HourglassIcon />}
              label="Holding a seat elsewhere"
              sx={{ mt: 0.5, height: 20, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }}
            />
          )}
          {signup.movedById && !compact && (
            <Tooltip title="An admin moved this candidate">
              <Chip size="small" variant="outlined" label="Moved" sx={{ mt: 0.5, height: 20 }} />
            </Tooltip>
          )}
        </Box>
        <Button
          size="small"
          aria-label={`Actions for ${fullName(signup.candidate)}`}
          onClick={(e) => {
            e.stopPropagation();
            setAnchor(e.currentTarget);
          }}
          sx={{ minWidth: 28, p: 0.25 }}
        >
          <MoreIcon fontSize="small" />
        </Button>
      </Stack>

      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {slots
          .filter((slot) => slot.id !== currentSlotId)
          .map((slot) => (
            <MenuItem
              key={slot.id}
              onClick={() => {
                setAnchor(null);
                onMove(signup, slot);
              }}
            >
              Move to {slotHeading(slot)}
            </MenuItem>
          ))}
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onRemove(signup);
          }}
          sx={{ color: 'error.main' }}
        >
          Remove from interview
        </MenuItem>
      </Menu>
    </Paper>
  );
}

/** One slot: heading, seat meter, confirmed candidates, then the waitlist tray. */
function SlotColumn({ slot, slots, compact, filter, onMove, onRemove, showInterviewTitle }) {
  const { setNodeRef, isOver } = useDroppable({ id: slot.id });

  const confirmed = slot.signups.filter((s) => s.status === 'CONFIRMED');
  const waiting = slot.signups.filter((s) => s.status !== 'CONFIRMED');
  const capacity = slot.candidateCapacity;
  const pct = capacity ? Math.min(100, (confirmed.length / capacity) * 100) : 0;

  const matches = (signup) =>
    !filter || fullName(signup.candidate).toLowerCase().includes(filter.toLowerCase());

  return (
    <Paper
      ref={setNodeRef}
      variant="outlined"
      data-testid={`slot-${slot.id}`}
      sx={{
        p: 1.5,
        minWidth: compact ? 200 : 300,
        flex: compact ? '0 0 auto' : 1,
        bgcolor: isOver ? 'action.hover' : undefined,
        borderColor: slot.isOverCapacity ? 'warning.main' : undefined,
        borderWidth: slot.isOverCapacity ? 2 : 1,
      }}
    >
      <Typography variant="subtitle2" fontWeight={700} noWrap>
        {slotHeading(slot)}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        {formatDay(slot.startTime)}
        {slot.location ? ` · ${slot.location}` : ''}
      </Typography>
      {/* Only when a round spans more than one interview, which is how a coffee
          chat morning and afternoon are actually modelled. Repeating the same
          title on every column when there is only one would be noise. */}
      {slot.interviewTitle && showInterviewTitle && (
        <Typography variant="caption" color="text.disabled" display="block" noWrap>
          {slot.interviewTitle}
        </Typography>
      )}
      {slot.isBookable === false && (
        <Chip
          size="small"
          variant="outlined"
          label="Not open to signup"
          sx={{ mt: 0.5, height: 20, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }}
        />
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1, mb: 1 }}>
        <Typography variant="caption" fontWeight={600}>
          {confirmed.length}
          {capacity != null ? ` / ${capacity}` : ''}
        </Typography>
        {capacity != null && (
          <LinearProgress
            variant="determinate"
            value={pct}
            color={slot.isOverCapacity ? 'warning' : 'primary'}
            sx={{ flex: 1, height: 6, borderRadius: 3 }}
          />
        )}
      </Stack>

      {/* Stated every time the page is opened, not just when it happened. */}
      {slot.isOverCapacity && (
        <Alert severity="warning" icon={<WarningIcon fontSize="inherit" />} sx={{ mb: 1, py: 0 }}>
          <Typography variant="caption">Over capacity</Typography>
        </Alert>
      )}

      <Stack spacing={0.75}>
        {confirmed.map((signup) => (
          <CandidateCard
            key={signup.id}
            signup={signup}
            slots={slots}
            currentSlotId={slot.id}
            compact={compact}
            dimmed={!matches(signup)}
            onMove={onMove}
            onRemove={onRemove}
          />
        ))}
        {confirmed.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ py: 1 }}>
            Nobody yet
          </Typography>
        )}
      </Stack>

      {waiting.length > 0 && (
        <>
          <Divider sx={{ my: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              Waiting ({waiting.length})
            </Typography>
          </Divider>
          <Stack spacing={0.75}>
            {waiting.map((signup) => (
              <CandidateCard
                key={signup.id}
                signup={signup}
                slots={slots}
                currentSlotId={slot.id}
                compact={compact}
                dimmed={!matches(signup)}
                onMove={onMove}
                onRemove={onRemove}
              />
            ))}
          </Stack>
        </>
      )}
    </Paper>
  );
}

/**
 * Every slot in an interview, side by side.
 *
 * One implementation, two shapes. A coffee chat day is two wide columns of
 * forty; a first round day is sixteen narrow columns of four. That is a density
 * prop derived from the data, not a second component - the thing being rendered
 * is the same thing.
 */
export default function InterviewRosterGallery({
  roster,
  onMove,
  onRemove,
  onPlace,
  busy = false,
}) {
  const [filter, setFilter] = useState('');
  const [pendingMove, setPendingMove] = useState(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  const slots = roster?.slots ?? [];
  const compact = slots.length > 3;
  // A round can span sibling interviews ("Coffee Chat - Round 1" and "Round 2"),
  // in which case each column needs to say which one it belongs to.
  const spansInterviews = new Set(slots.map((slot) => slot.interviewId).filter(Boolean)).size > 1;

  const needsPlacement = useMemo(
    () => slots.flatMap((slot) => slot.signups.filter((s) => s.status === 'NEEDS_PLACEMENT')),
    [slots]
  );

  const requestMove = (signup, slot) => {
    const confirmed = slot.signups.filter((s) => s.status === 'CONFIRMED').length;
    const full = slot.candidateCapacity != null && confirmed >= slot.candidateCapacity;
    // Ask before overfilling rather than refusing: the admin is allowed to do
    // it, they just should not do it by accident.
    if (full) {
      setPendingMove({ signup, slot, confirmed });
      return;
    }
    onMove(signup, slot, { force: false });
  };

  const handleDragEnd = ({ active, over }) => {
    if (!over) return;
    const slot = slots.find((s) => s.id === over.id);
    const signup = slots.flatMap((s) => s.signups).find((s) => s.id === active.id);
    if (!slot || !signup || signup.slotId === slot.id) return;
    requestMove(signup, slot);
  };

  if (!roster) return null;

  return (
    <Box>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        {/* One filter for the whole gallery. The page this replaces had five
            separate search boxes, which is the wrong interaction when the point
            is to see everything at once - so this dims rather than removes. */}
        <TextField
          size="small"
          placeholder="Find a candidate"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          sx={{ maxWidth: 280 }}
          inputProps={{ 'aria-label': 'Find a candidate' }}
        />
        <Typography variant="caption" color="text.secondary">
          {slots.length} session{slots.length === 1 ? '' : 's'} ·{' '}
          {slots.reduce((n, s) => n + s.signups.filter((x) => x.status === 'CONFIRMED').length, 0)} scheduled
        </Typography>
      </Stack>

      {needsPlacement.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <AlertTitle>
            {needsPlacement.length} candidate{needsPlacement.length === 1 ? '' : 's'} could not be scheduled
          </AlertTitle>
          Every session was full when they signed up. Place them into a session below - you can go over
          capacity if you need to.
          <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }}>
            {needsPlacement.map((signup) => (
              <Chip key={signup.id} size="small" color="error" label={fullName(signup.candidate)} />
            ))}
          </Stack>
        </Alert>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <Box
          sx={{
            display: 'flex',
            gap: 2,
            alignItems: 'flex-start',
            overflowX: 'auto',
            pb: 1,
            opacity: busy ? 0.6 : 1,
            pointerEvents: busy ? 'none' : 'auto',
          }}
        >
          {slots.map((slot) => (
            <SlotColumn
              key={slot.id}
              slot={slot}
              slots={slots}
              compact={compact}
              filter={filter}
              showInterviewTitle={spansInterviews}
              onMove={requestMove}
              onRemove={onRemove}
            />
          ))}
          {slots.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
              No sessions yet. Add times before candidates can sign up.
            </Typography>
          )}
        </Box>
      </DndContext>

      {roster.unassigned?.length > 0 && (
        <Paper variant="outlined" sx={{ mt: 3, p: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <PersonOffIcon fontSize="small" color="disabled" />
            <Typography variant="subtitle2">
              Not scheduled ({roster.unassigned.length})
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            In this round, but not in any session yet.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {roster.unassigned.map((application) => (
              <Chip
                key={application.id}
                size="small"
                label={fullName(application)}
                onClick={onPlace ? () => onPlace(application) : undefined}
              />
            ))}
          </Stack>
        </Paper>
      )}

      <Dialog open={Boolean(pendingMove)} onClose={() => setPendingMove(null)}>
        <DialogTitle>This session is full</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingMove && (
              <>
                <strong>{slotHeading(pendingMove.slot)}</strong> already has {pendingMove.confirmed} of{' '}
                {pendingMove.slot.candidateCapacity} seats filled. Move{' '}
                {fullName(pendingMove.signup.candidate)} there anyway?
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingMove(null)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              onMove(pendingMove.signup, pendingMove.slot, { force: true });
              setPendingMove(null);
            }}
          >
            Move anyway
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
