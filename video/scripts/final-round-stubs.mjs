// The final round page's data, shared by the two final round captures: one room with
// two made-up candidates, a case deck (scripts/sample-case.mjs), Round One history and
// the interview chat. None of these people are real.
import { readFileSync } from "node:fs";
import { decisionGuideResponse, interviewChat } from "./stubs.mjs";

export const SAMPLE_USER = {
  id: "sample-member",
  firstName: "Jordan",
  lastName: "Rivera",
  fullName: "Jordan Rivera",
  email: "jordan.rivera@g.ucla.edu",
  role: "MEMBER",
};
export const SAMPLE_ADMIN = { id: "sample-admin", firstName: "Alex", lastName: "Moreno", fullName: "Alex Moreno", email: "alex.moreno@g.ucla.edu", role: "ADMIN" };
const PRIYA = { id: "m-priya", fullName: "Priya Shah", email: "priya.shah@g.ucla.edu" };

export const INTERVIEW = {
  id: "iv-final",
  title: "Fall 2026 Final Rounds",
  description: "",
  interviewType: "FINAL_ROUND",
  startDate: "2026-10-28T21:00:00.000Z",
  endDate: "2026-10-29T01:00:00.000Z",
  location: "Royce Hall",
  dresscode: "Business professional",
  status: "UPCOMING",
  cycleId: "cycle-fall",
  cycle: { id: "cycle-fall", name: "Fall 2026" },
};
export const GROUP = "room-f";

const app = (id, firstName, lastName, major, year, phoneNumber) => ({
  id,
  candidateId: `cand-${id}`,
  studentId: null,
  firstName,
  lastName,
  name: `${firstName} ${lastName}`,
  email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@g.ucla.edu`,
  phoneNumber,
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
  app("a1", "Taylor", "Kim", "Business Economics", 2028, "(310) 555-0142"),
  app("a2", "Sam", "Okafor", "Psychology", 2028, "(310) 555-0188"),
];

export const CONFIG = {
  source: "slots",
  memberGroups: [{ id: `members-${GROUP}`, name: "Royce 156 · 2:00 PM", memberIds: [SAMPLE_USER.id, PRIYA.id], slotId: GROUP }],
  applicationGroups: [{ id: GROUP, name: "Royce 156 · 2:00 PM", notes: "", applicationIds: ["a1", "a2"], slotId: GROUP }],
  groupAssignments: { [`members-${GROUP}`]: [GROUP] },
};

export const SHARED = ["Tell us about a time you disagreed with a teammate.", "What would you want to work on first at UConsulting?"];

export const CASES = [
  { id: "case-1", title: "Westwood Coffee Co.", description: "Fifth café or catering?", status: "ACTIVE", pagesUploaded: 4, pageCount: 4, assignedCount: 0, createdBy: SAMPLE_ADMIN.fullName },
  { id: "case-2", title: "Bruin Bikes Expansion", description: "", status: "ACTIVE", pagesUploaded: 5, pageCount: 5, assignedCount: 3, createdBy: SAMPLE_ADMIN.fullName },
  { id: "case-3", title: "Sunset Rec Pricing", description: "", status: "DRAFT", pagesUploaded: 3, pageCount: 3, assignedCount: 0, createdBy: "Priya Shah" },
];
const PAGES = [
  { id: "p1", pageNumber: 1, pageType: "NORMAL", exhibitLabel: null, width: 1600, height: 900 },
  { id: "p2", pageNumber: 2, pageType: "EXHIBIT", exhibitLabel: "Exhibit 1", width: 1600, height: 900 },
  { id: "p3", pageNumber: 3, pageType: "EXHIBIT", exhibitLabel: "Exhibit 2", width: 1600, height: 900 },
  { id: "p4", pageNumber: 4, pageType: "INTERVIEWER_ONLY", exhibitLabel: null, width: 1600, height: 900 },
];

const ROUND_ONE = (applicationId) => ({
  applicationId,
  interviews: [
    {
      interviewId: "iv-r1",
      title: "Fall 2026 First Rounds",
      interviewType: "ROUND_ONE",
      startDate: "2026-10-20T16:00:00.000Z",
      endDate: "2026-10-21T01:00:00.000Z",
      questions: [
        { id: "r1q1", text: "Tell us about a time you led a team through a setback.", order: 0, scope: "GROUP" },
        { id: "r1q2", text: "You cut restocking time from three days to one. How did you find the bottleneck?", order: 1, scope: "CANDIDATE" },
      ],
      evaluators: [
        {
          evaluationId: "e1",
          evaluatorId: PRIYA.id,
          evaluatorName: PRIYA.fullName,
          decision: "YES",
          notesByQuestionId: { r1q1: "Owned the miss, rebuilt the volunteer rota.", r1q2: "Shadowed volunteers for a week to find it." },
          marketSizingNotes: "Clean top-down structure.",
          additionalNotes: "Strong all round. Push on structure in final.",
          submittedAt: "2026-10-20T18:10:00.000Z",
        },
      ],
    },
  ],
});

/**
 * The API for the final round page and its neighbours. `state` is shared with the
 * flow: who is signed in, whether the case is still locked, what has been saved.
 */
export function finalRoundApi({ docs, casePages, state }) {
  const assignments = state.assignments ?? {};
  const guide = decisionGuideResponse("final", "Final Round");
  const chat = interviewChat({
    interview: INTERVIEW,
    me: SAMPLE_USER,
    colleague: PRIYA,
    opening: "I'll run the case for Sam. Can you run it for Taylor?",
  });
  state.chat = chat;
  state.saves = [];
  state.shared = state.shared ?? [];

  const assignmentRow = (a) => {
    const asg = assignments[a.id];
    return {
      applicationId: a.id,
      name: a.name,
      major: a.major,
      year: a.year,
      assignment: asg ? { id: `ca-${a.id}`, caseId: asg, caseTitle: CASES.find((c) => c.id === asg).title, caseStatus: "ACTIVE", overriddenBy: null, overriddenAt: null } : null,
    };
  };

  return async function api({ path, req, route, json, url }) {
    const method = req.method();
    const me = state.as === "admin" ? SAMPLE_ADMIN : SAMPLE_USER;
    if (path === "/auth/verify") return json({ user: me });
    if (path === "/member/resume") return json({ resume: { id: "sample-resume" } });
    if (path === "/member/profile") return json({ ...SAMPLE_USER, studentId: null, profileImage: null, createdAt: "2025-10-01T00:00:00.000Z" });
    if (path === "/admin/profile") return state.as === "admin" ? json(SAMPLE_ADMIN) : json({ error: "Forbidden" }, 403);
    if (path === "/admin/cycles/active") return json(INTERVIEW.cycle);

    // Cases (admin)
    if (path === "/cases" && method === "GET") return json(CASES.map((c) => ({ ...c, assignedCount: c.id === "case-1" ? Object.keys(assignments).length : c.assignedCount })));
    if (path === "/cases/visibility-setting" && method === "GET") return json({ leadTimeHours: state.leadTimeHours ?? 2, updatedAt: null, updatedById: null });
    if (path === "/cases/visibility-setting" && method === "PATCH") {
      state.leadTimeHours = req.postDataJSON().leadTimeHours;
      return json({ leadTimeHours: state.leadTimeHours, updatedAt: new Date().toISOString(), updatedById: SAMPLE_ADMIN.id });
    }
    if (path === "/admin/interviews") return json([INTERVIEW]);
    if (path === "/cases/active") return json(CASES.filter((c) => c.status === "ACTIVE").map(({ id, title, pageCount }) => ({ id, title, pageCount })));
    if (path === "/cases/assignments/for-interview") return json(APPS.map(assignmentRow));
    if (path === "/cases/assignments" && method === "POST") {
      const { applicationId, caseId } = req.postDataJSON();
      assignments[applicationId] = caseId;
      return json({ id: `ca-${applicationId}`, applicationId, caseId, caseTitle: CASES.find((c) => c.id === caseId).title });
    }
    if (path === `/cases/interviews/${INTERVIEW.id}/permissions`) return json({ canManage: false });
    if (path === "/cases/case-1" && method === "GET") {
      if (state.caseLocked) {
        return json({ error: "This case unlocks closer to the interview.", code: "CASE_LOCKED", unlocksAt: state.unlocksAt }, 423);
      }
      return json({ id: "case-1", title: "Westwood Coffee Co.", description: "", status: "ACTIVE", cycleId: "cycle-fall", cycleName: "Fall 2026", pageCount: 4, hasPdf: true, pages: PAGES });
    }
    const img = /^\/cases\/case-1\/pages\/(p\d)\/image$/.exec(path);
    if (img) return route.fulfill({ status: 200, contentType: "image/png", body: readFileSync(casePages[img[1]]) });

    // My Interviews and the final round page
    const base = `/member/interviews/${INTERVIEW.id}`;
    if (path === "/member/interviews") return json([INTERVIEW]);
    if (path === base) return json(INTERVIEW);
    if (path === `${base}/config` && method === "GET") {
      const ids = (url.searchParams.get("groupIds") || "").split(",").filter(Boolean);
      const qs = state.shared.map((text, i) => ({ id: `bq-${i}`, text, order: i, groupId: GROUP, createdBy: { id: SAMPLE_USER.id, fullName: SAMPLE_USER.fullName } }));
      return json(ids.length ? { ...CONFIG, behavioralQuestions: { [GROUP]: qs } } : CONFIG);
    }
    if (path === `${base}/config` && method === "PATCH") {
      state.shared = req.postDataJSON().config.questions;
      return json({ success: true, message: "Behavioral questions updated successfully" });
    }
    if (path === `${base}/applications`) return json(APPS);
    if (path === "/member/evaluations" && method === "GET") return json(state.evaluations ?? []);
    if (path === "/member/evaluations" && method === "POST") {
      const body = req.postDataJSON();
      state.saves.push(body);
      return json({ id: `ev-${body.applicationId}`, ...body });
    }
    const hist = /^\/member\/applications\/(a\d)\/round-one-history$/.exec(path);
    if (hist) return json(ROUND_ONE(hist[1]));
    if (path === "/decision-guides/final") return json(guide);
    if (path.startsWith(`${base}/session-questions`)) return json([]);
    if (path.startsWith(`${base}/question-bank`)) return json(path.endsWith("facets") ? { categories: [], rounds: [] } : []);
    if (chat.handle(path, json, req)) return;

    if (path.startsWith("/files/")) {
      return route.fulfill({ status: 200, contentType: "application/pdf", body: readFileSync(docs.resume) });
    }
    return false;
  };
}
