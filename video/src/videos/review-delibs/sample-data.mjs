// Made-up review teams, applicants and grades for the review team deliberation
// tutorial. None of these are real people. The capture runs them through the
// server's own teamStats.js, so every number on screen is what the real page
// would show for this data.
//
// The story the data tells: Review Team 4 grades resumes harsher than the other
// teams, Jordan Lee is behind most of its outliers (mostly low), the two who
// graded Diego's short answer are split, and Jordan has not graded it yet.

export const ADMIN = {
  id: "admin-morgan",
  firstName: "Morgan",
  lastName: "Ellis",
  fullName: "Morgan Ellis",
  email: "morgan.ellis@g.ucla.edu",
  role: "ADMIN",
};

export const MEMBERS = [
  { id: "m-priya", fullName: "Priya Shah", email: "priya.shah@g.ucla.edu" },
  { id: "m-marcus", fullName: "Marcus Bell", email: "marcus.bell@g.ucla.edu" },
  { id: "m-jordan", fullName: "Jordan Lee", email: "jordan.lee@g.ucla.edu" },
];

export const MEMBER_VIEWER = { ...MEMBERS[0], firstName: "Priya", lastName: "Shah", role: "MEMBER" };

export const TEAM = { id: "team-4", name: "Review Team 4" };

const SHORT_ANSWER =
  "I want to consult because the best moments of my week are when a messy problem finally has a shape. " +
  "Running inventory for the Bruin Food Pantry taught me to ask why before how: we cut restocking from three days " +
  "to one by mapping every handoff first. UConsulting's nonprofit projects are where I want to keep learning that.";

// [name, major, year, resume scores (Priya, Marcus, Jordan), short answer, video]
// null = not graded yet.
const ROSTER = [
  ["Avery Chen", "Business Economics", "2028", [9, 9, 4], [2.33, 2.67, 2], [2, 2, 1]],
  ["Diego Ramirez", "Statistics", "2027", [7, 8, 7], [3, 1, null], [1, 1, 1]],
  ["Hannah Okafor", "Economics", "2028", [10, 11, 5], [2.67, 3, 2.33], [2, 2, 2]],
  ["Leo Park", "Computer Science", "2029", [6, 6, 6], [2, 2, 1.67], [1, 1, 0]],
  ["Nina Patel", "Political Science", "2028", [8, 3, 8], [2.33, 2.67, 2.33], [2, 1, 2]],
  ["Omar Haddad", "Mathematics", "2027", [7, 7, 2], [2, 2.33, 1.33], [1, 1, 1]],
  ["Sofia Rossi", "Psychology", "2029", [9, 10, 10], [3, 2.67, 2.67], [2, 2, 2]],
  ["Theo Nguyen", "Cognitive Science", "2028", [5, 6, 6], [1.67, 2, 2], [1, 1, 1]],
];

export const APPLICATIONS = ROSTER.map(([name, major, year], i) => {
  const [firstName, lastName] = name.split(" ");
  return {
    id: `app-${i + 1}`,
    candidateId: `cand-${i + 1}`,
    cycleId: "cycle-fall",
    firstName,
    lastName,
    name,
    major1: major,
    graduationYear: year,
    cumulativeGpa: (3.5 + ((i * 7) % 5) / 10).toFixed(2),
    headshotUrl: null,
    resumeUrl: `/api/files/sample-resume-${i + 1}/pdf`,
    coverLetterUrl: null,
    shortAnswer: SHORT_ANSWER,
    videoUrl: `/api/files/sample-video-${i + 1}/pdf`,
    resumeDecision: null,
  };
});

let scoreSeq = 0;
const row = (type, candidateId, evaluator, overall, assignedGroupId) => ({
  id: `score-${++scoreSeq}`,
  type,
  candidateId,
  evaluatorId: evaluator.id,
  evaluator: { fullName: evaluator.fullName },
  overallScore: overall,
  adminScore: null,
  assignedGroupId,
});

/** Every score row in the cycle, this team's and the other teams'. */
export function sampleScores() {
  scoreSeq = 0;
  const rows = [];
  ROSTER.forEach(([, , , resume, short, video], i) => {
    const candidateId = `cand-${i + 1}`;
    MEMBERS.forEach((member, m) => {
      if (resume[m] !== null) rows.push(row("resume", candidateId, member, resume[m], TEAM.id));
      if (short[m] !== null) rows.push(row("coverLetter", candidateId, member, short[m], TEAM.id));
      if (video[m] !== null) rows.push(row("video", candidateId, member, video[m], TEAM.id));
    });
  });
  for (const team of OTHER_TEAMS) {
    team.candidates.forEach((candidate, k) => {
      team.graders.forEach((grader, g) => {
        const wobble = ((k + g) % 3) - 1;
        rows.push(row("resume", candidate.candidateId, grader, team.resume + wobble, team.id));
        rows.push(row("coverLetter", candidate.candidateId, grader, Math.min(3, Math.max(1, team.short + wobble / 3)), team.id));
        rows.push(row("video", candidate.candidateId, grader, Math.min(2, Math.max(0, team.video + (wobble > 0 ? 0 : wobble / 2))), team.id));
      });
    });
  }
  return rows;
}

// The rest of the cycle, only ever seen as dots on the overview's comparison.
const otherTeam = (n, resume, short, video) => ({
  id: `team-${n}`,
  name: `Review Team ${n}`,
  resume,
  short,
  video,
  graders: [0, 1, 2].map((g) => ({ id: `o${n}-${g}`, fullName: `Team ${n} grader ${g + 1}` })),
  candidates: [0, 1, 2, 3, 4, 5].map((k) => ({ candidateId: `o${n}-cand-${k}`, applicationId: `o${n}-app-${k}` })),
});

export const OTHER_TEAMS = [
  otherTeam(1, 9, 2.4, 1.6),
  otherTeam(2, 8.5, 2.2, 1.4),
  otherTeam(3, 9.5, 2.5, 1.5),
  otherTeam(5, 8, 2.3, 1.3),
  otherTeam(6, 9, 2.1, 1.5),
];

export const SHORT_ANSWER_PROMPT = "Why do you want to join UConsulting, and what would you bring to a case team?";
