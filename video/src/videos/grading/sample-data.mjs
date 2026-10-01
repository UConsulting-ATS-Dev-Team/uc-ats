// Made-up members and applicants for the grading tutorial. None of these are
// real people; the IDs only have the shape of a UCLA UID. Shared by the
// reference capture (scripts/capture-ref.mjs) and the video itself.

export const SAMPLE_USER = {
  id: "sample-member",
  firstName: "Jordan",
  lastName: "Rivera",
  fullName: "Jordan Rivera",
  email: "jordan.rivera@g.ucla.edu",
  role: "MEMBER",
};

const SHORT_ANSWER =
  "Last spring I led a team of five to redesign how our student food pantry tracks inventory. " +
  "We interviewed volunteers, mapped every handoff, and cut restocking time from three days to one. " +
  "That project is why I want to consult: I love walking into a messy problem, asking better questions, " +
  "and leaving behind something that works. UConsulting's pro bono projects with local nonprofits are exactly " +
  "the kind of work I want to learn from, and I would bring the same curiosity to every case team I join.";

const app = (i, over) => ({
  id: `app-${i}`,
  candidateId: `cand-${i}`,
  cycleId: "cycle-fall",
  groupName: "Review Team 4",
  email: `applicant${i}@g.ucla.edu`,
  gender: "Other",
  isFirstGeneration: false,
  isTransferStudent: false,
  submittedAt: `2026-09-2${i % 9}T18:00:00.000Z`,
  resumeUrl: `/api/files/sample-resume-${i}.pdf`,
  coverLetterUrl: null,
  shortAnswer: SHORT_ANSWER,
  videoUrl: `/api/files/sample-video-${i}.mp4`,
  hasResumeScore: false,
  hasCoverLetterScore: false,
  hasVideoScore: false,
  ...over,
});

export const SAMPLE_APPS = [
  app(1, { name: "Taylor Kim", studentId: 905118264, major: "Business Economics", year: 2028 }),
  app(2, { studentId: 905227391, major: "Computer Science", year: 2029, hasResumeScore: true }),
  app(3, { name: "Sam Okafor", studentId: 905340517, major: "Psychology", year: 2028 }),
  app(4, { studentId: 905462088, major: "Statistics", year: 2027, hasResumeScore: true, hasCoverLetterScore: true }),
  app(5, { studentId: 905581936, major: "Political Science", year: 2029 }),
  app(6, { studentId: 905690402, major: "Economics", year: 2028, hasVideoScore: true }),
];

export const SAMPLE_SHORT_ANSWER = SHORT_ANSWER;
