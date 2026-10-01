// Made-up members and candidates for the coffee chat tutorial. None of these
// are real people. Shapes follow what the member routes return (see
// scripts/flows/coffee-chats.mjs for which route answers with what).

export const SAMPLE_USER = {
  id: "sample-member",
  firstName: "Jordan",
  lastName: "Rivera",
  fullName: "Jordan Rivera",
  email: "jordan.rivera@g.ucla.edu",
  role: "MEMBER",
  graduationClass: "Fall 2025",
};

const colleague = (id, fullName) => ({ id: `ia-${id}`, role: "INTERVIEWER", user: { id, fullName, email: `${id}@g.ucla.edu` } });

export const INTERVIEW = {
  id: "iv-coffee",
  title: "Fall 2026 Coffee Chats",
  description: "",
  interviewType: "COFFEE_CHAT",
  startDate: "2026-10-14T16:00:00.000Z",
  endDate: "2026-10-15T03:00:00.000Z",
  location: "Kerckhoff Coffee House",
  dresscode: "Business casual",
  status: "UPCOMING",
  cycleId: "cycle-fall",
  cycle: { id: "cycle-fall", name: "Fall 2026" },
};

/** The sittings on Interview RSVP. The member claims the afternoon one. */
export const SLOTS = [
  {
    id: "s-am",
    label: "Morning Session",
    startTime: "2026-10-14T17:00:00.000Z",
    endTime: "2026-10-14T18:00:00.000Z",
    location: "Kerckhoff Coffee House",
    interviewerCapacity: 3,
    candidateCount: 9,
    interviewers: [colleague("m-priya", "Priya Shah"), colleague("m-marcus", "Marcus Bell"), colleague("m-elena", "Elena Torres")],
    yourAssignmentId: null,
  },
  {
    id: "s-pm",
    label: "Afternoon Session",
    startTime: "2026-10-14T21:00:00.000Z",
    endTime: "2026-10-14T22:00:00.000Z",
    location: "Kerckhoff Coffee House",
    interviewerCapacity: 3,
    candidateCount: 7,
    interviewers: [colleague("m-priya", "Priya Shah")],
    yourAssignmentId: null,
  },
  {
    id: "s-eve",
    label: "Evening Session",
    startTime: "2026-10-15T01:00:00.000Z",
    endTime: "2026-10-15T02:00:00.000Z",
    location: "Ackerman Union, Room 2408",
    interviewerCapacity: 3,
    candidateCount: 6,
    interviewers: [],
    yourAssignmentId: null,
  },
];

export const claimed = (slots) =>
  slots.map((s) =>
    s.id === "s-pm"
      ? { ...s, yourAssignmentId: "ia-me", interviewers: [...s.interviewers, { id: "ia-me", role: "INTERVIEWER", user: SAMPLE_USER }] }
      : s,
  );

const app = (id, firstName, lastName, major, year) => ({
  id,
  candidateId: `cand-${id}`,
  studentId: null,
  firstName,
  lastName,
  name: `${firstName} ${lastName}`,
  email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@g.ucla.edu`,
  phoneNumber: null,
  major1: major,
  major,
  graduationYear: year,
  year,
  resumeUrl: `/api/files/resume-${id}/pdf`,
  coverLetterUrl: null,
  shortAnswer: null,
  videoUrl: null,
  headshotUrl: null,
  testFor: null,
});

export const APPS = [
  app("a1", "Taylor", "Kim", "Business Economics", 2028),
  app("a2", "Sam", "Okafor", "Psychology", 2028),
  app("a3", "Avery", "Chen", "Statistics", 2029),
  app("a4", "Diego", "Martinez", "Economics", 2027),
  app("a5", "Noor", "Haddad", "Cognitive Science", 2029),
  app("a6", "Leah", "Goldberg", "Political Science", 2028),
  app("a7", "Chris", "Park", "Computer Science", 2029),
];

/** The afternoon sitting's groups, as GET /member/interviews/:id/config builds them from the roster. */
export const CONFIG = {
  source: "slots",
  memberGroups: [{ id: "members-s-pm", name: "Afternoon Session", memberIds: [SAMPLE_USER.id, "m-priya"], slotId: "s-pm" }],
  applicationGroups: [
    { id: "s-pm:1A", name: "Afternoon Session · 1A", notes: null, applicationIds: ["a1", "a2", "a3"], slotId: "s-pm", groupLabel: "1A" },
    { id: "s-pm:1B", name: "Afternoon Session · 1B", notes: null, applicationIds: ["a4", "a5"], slotId: "s-pm", groupLabel: "1B" },
    { id: "s-pm:1C", name: "Afternoon Session · 1C", notes: null, applicationIds: ["a6", "a7"], slotId: "s-pm", groupLabel: "1C" },
  ],
  groupAssignments: { "members-s-pm": ["s-pm:1A", "s-pm:1B", "s-pm:1C"] },
};

/** What the member writes during the chat, and decides, per candidate. */
export const NOTES = {
  a1: "Ran the pantry inventory overhaul. Asked sharp questions about our pro bono clients.",
  a2: "Thoughtful, a little quiet at first. Lit up talking about user research.",
  a3: "Curious about the tech committee. Great follow-ups.",
};
export const DECISIONS = { a1: "YES", a2: "MAYBE_YES", a3: "YES" };
