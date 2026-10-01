// Made-up members and candidates for the first round setup tutorial. None of these
// are real people. Taylor Kim's resume is scripts/sample-docs.mjs, which is where
// the candidate-specific question comes from.

export const SAMPLE_USER = {
  id: "sample-member",
  firstName: "Jordan",
  lastName: "Rivera",
  fullName: "Jordan Rivera",
  email: "jordan.rivera@g.ucla.edu",
  role: "MEMBER",
};

export const INTERVIEW = {
  id: "iv-r1",
  title: "Fall 2026 First Rounds",
  description: "",
  interviewType: "ROUND_ONE",
  startDate: "2026-10-20T16:00:00.000Z",
  endDate: "2026-10-21T01:00:00.000Z",
  location: "Bunche Hall",
  dresscode: "Business professional",
  status: "UPCOMING",
  cycleId: "cycle-fall",
  cycle: { id: "cycle-fall", name: "Fall 2026" },
};

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
];

/** One first round session is one room: the session is the group. */
export const CONFIG = {
  source: "slots",
  memberGroups: [{ id: "members-room2", name: "Bunche 2150 · 10:00 AM", memberIds: [SAMPLE_USER.id, "m-priya"], slotId: "room2" }],
  applicationGroups: [
    { id: "room2", name: "Bunche 2150 · 10:00 AM", notes: "", applicationIds: ["a1", "a2", "a3"], slotId: "room2" },
  ],
  groupAssignments: { "members-room2": ["room2"] },
};

/** Typed into the shared list: every candidate in the room is asked these. */
export const SHARED = [
  "Tell us about a time you led a team through a setback.",
  "Why consulting, and why UConsulting?",
];

/** Typed for Taylor alone, from the pantry line on their resume. */
export const FOR_TAYLOR = "You cut restocking time from three days to one. How did you find the bottleneck?";
