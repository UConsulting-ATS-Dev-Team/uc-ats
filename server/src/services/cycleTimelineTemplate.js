// Declarative recruitment timeline template used to bootstrap a recruiting cycle.
//
// The stage list is the single source of truth for the cycle-create timeline
// form, the generated event shells, and the public change-set. Adding or
// reordering a stage is a change to this file only — no migration and no
// hard-coded Fall/Winter dates, so Fall -> Winter is dates and copy only.
//
// Stage shape:
//   key            stable identifier persisted on generated events
//   label          admin-facing label
//   type           'milestone' (single date) | 'window' (start + end)
//   required       blocks commit when missing
//   generatesEvent whether an Events shell is created for this stage
//   eventName      name for the generated event
//   needsForms     generated event is expected to have RSVP/attendance forms
//   publicFacing   included in the website/Linktree change-set
//   cycleField     legacy RecruitingCycle column this stage also writes

export const CYCLE_TIMELINE_STAGES = [
  {
    key: 'applications_open',
    label: 'Applications open',
    type: 'milestone',
    required: true,
    generatesEvent: false,
    publicFacing: true
  },
  {
    key: 'info_session',
    label: 'Info session',
    type: 'window',
    required: false,
    generatesEvent: true,
    eventName: 'Info Session',
    needsForms: true,
    publicFacing: true
  },
  {
    key: 'gtkuc',
    label: 'Get to Know UC',
    type: 'window',
    required: false,
    generatesEvent: true,
    eventName: 'Get to Know UC',
    needsForms: false,
    publicFacing: true
  },
  {
    key: 'applications_close',
    label: 'Applications close',
    type: 'milestone',
    required: true,
    generatesEvent: false,
    publicFacing: true
  },
  {
    key: 'resume_deadline',
    label: 'Resume deadline',
    type: 'milestone',
    required: false,
    generatesEvent: false,
    publicFacing: true,
    cycleField: 'resumeDeadline'
  },
  {
    key: 'cover_letter_deadline',
    label: 'Cover letter deadline',
    type: 'milestone',
    required: false,
    generatesEvent: false,
    publicFacing: true,
    cycleField: 'coverLetterDeadline'
  },
  {
    key: 'video_deadline',
    label: 'Video deadline',
    type: 'milestone',
    required: false,
    generatesEvent: false,
    publicFacing: true,
    cycleField: 'videoDeadline'
  },
  {
    key: 'coffee_chats',
    label: 'Coffee chats',
    type: 'window',
    required: false,
    generatesEvent: true,
    eventName: 'Coffee Chats',
    needsForms: true,
    publicFacing: true
  },
  {
    key: 'round_one',
    label: 'Round 1 interviews',
    type: 'window',
    required: false,
    generatesEvent: true,
    eventName: 'Round 1 Interviews',
    needsForms: true,
    publicFacing: false
  },
  {
    key: 'round_two',
    label: 'Round 2 interviews',
    type: 'window',
    required: false,
    generatesEvent: true,
    eventName: 'Round 2 Interviews',
    needsForms: true,
    publicFacing: false
  },
  {
    key: 'final_round',
    label: 'Final round',
    type: 'window',
    required: false,
    generatesEvent: true,
    eventName: 'Final Round',
    needsForms: true,
    publicFacing: false
  },
  {
    key: 'deliberations',
    label: 'Deliberations',
    type: 'window',
    required: false,
    generatesEvent: true,
    eventName: 'Deliberations',
    needsForms: false,
    publicFacing: false
  },
  {
    key: 'offers_released',
    label: 'Offers released',
    type: 'milestone',
    required: false,
    generatesEvent: false,
    publicFacing: true
  }
];

export const STAGE_BY_KEY = new Map(CYCLE_TIMELINE_STAGES.map((stage) => [stage.key, stage]));

// Milestone stages default to a one-hour event when they generate one, so the
// non-null Events.eventEndDate is never derived from a guess elsewhere.
export const MILESTONE_EVENT_DURATION_MINUTES = 60;
