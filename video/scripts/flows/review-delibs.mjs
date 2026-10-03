// Running a Review Team Delib: start a session from Review Teams, the member's
// join prompt, the overview, overriding an outlier, the full list with a
// decision, and the summary.
//
// The stub below plays the server: it keeps one session's state and answers the
// /api/review-delibs calls the way services/reviewDelibs/reviewDelibs.js does.
// The numbers come from the server's own teamStats.js run over the sample data,
// so the overview, outliers and splits are exactly what the real page computes.
//
// Two browsers watch the session: the admin's (the harness's page) and a team
// member's, signed in with their own token. Like the real server, the stub tells
// them apart by the token on each request.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN,
  APPLICATIONS,
  MEMBERS,
  MEMBER_VIEWER,
  OTHER_TEAMS,
  SHORT_ANSWER_PROMPT,
  TEAM,
  sampleScores,
} from "../../src/videos/review-delibs/sample-data.mjs";
import { makeSampleDocs } from "../sample-docs.mjs";
import { expect, readServerConstant } from "../server-source.mjs";
import { computeTeamStats, normalizeRow, outlierOrder } from "../../../server/src/services/reviewDelibs/teamStats.js";

// ---------- rubrics: the shipped defaults, read out of the server ----------
const RUBRICS = readServerConstant("server/src/services/documentRubrics.js", "DEFAULT_RUBRICS", (r) => {
  for (const type of ["resume", "coverLetter", "video"]) {
    expect(Array.isArray(r?.[type]?.categories) && r[type].categories.length > 0, `DEFAULT_RUBRICS.${type}.categories`);
  }
});
const AGG = { resume: "sum", coverLetter: "average", video: "sum" };
const maxOf = (type) => {
  const maxes = RUBRICS[type].categories.map((c) => c.max);
  const sum = maxes.reduce((a, b) => a + b, 0);
  return AGG[type] === "average" ? sum / maxes.length : sum;
};
const MAX = { resume: maxOf("resume"), coverLetter: maxOf("coverLetter"), video: maxOf("video") };
const rubricResponse = {
  rubrics: Object.fromEntries(
    Object.keys(MAX).map((type) => [
      type,
      { type, aggregation: AGG[type], rubric: RUBRICS[type], minOverall: 0, maxOverall: MAX[type], customized: false, updatedAt: null },
    ]),
  ),
  types: ["resume", "coverLetter", "video"],
  participationMax: 3,
  stagingMax: MAX.resume + MAX.coverLetter + MAX.video + 3,
};

// ---------- who is asking ----------
const MEMBER_TOKEN = "sample-member-token";
const viewerOf = (req) => ((req.headers().authorization || "").includes(MEMBER_TOKEN) ? MEMBER_VIEWER : ADMIN);

// ---------- the sample cycle ----------
const apps = structuredClone(APPLICATIONS);
const scores = sampleScores();
const members = MEMBERS.map((m) => ({ id: m.id, name: m.fullName, profileImage: null }));
const groups = [
  { id: TEAM.id, name: TEAM.name, members },
  ...OTHER_TEAMS.map((t) => ({ id: t.id, name: t.name, members: t.graders.map((g) => ({ id: g.id, name: g.fullName })) })),
];
const candidates = [
  ...apps.map((a) => ({
    candidateId: a.candidateId,
    applicationId: a.id,
    groupId: TEAM.id,
    name: a.name,
    major: a.major1,
    year: a.graduationYear,
    hasDoc: { resume: true, coverLetter: true, video: true },
    get resumeDecision() { return a.resumeDecision; },
    locked: false,
  })),
  ...OTHER_TEAMS.flatMap((t) => t.candidates.map((c, k) => ({
    ...c,
    groupId: t.id,
    name: `${t.name} applicant ${k + 1}`,
    hasDoc: { resume: true, coverLetter: true, video: true },
    resumeDecision: "yes",
    locked: false,
  }))),
];

const stats = (thresholdPct) =>
  computeTeamStats({
    groupId: TEAM.id,
    thresholdPct,
    maxByType: MAX,
    groups,
    candidates,
    rows: scores.map((s) => normalizeRow(s, s.type)),
  });

// ---------- the session ----------
const STARTED = Date.now() - 4 * 60 * 1000 - 12 * 1000;
let session = null;
const changes = [];

const bump = () => { session.version += 1; };

function state(viewer) {
  // Priya and Marcus are on the call; Jordan has not joined.
  const present = [ADMIN.id, MEMBERS[0].id, MEMBERS[1].id];
  const people = [{ userId: ADMIN.id, name: ADMIN.fullName, role: "ADMIN", profileImage: null, isTeamMember: false, present: true }]
    .concat(MEMBERS.map((m) => ({ userId: m.id, name: m.fullName, role: "MEMBER", profileImage: null, isTeamMember: true, present: present.includes(m.id) })));
  return {
    version: session.version,
    now: Date.now(),
    session: {
      id: session.id,
      groupId: TEAM.id,
      groupName: TEAM.name,
      cycleId: "cycle-fall",
      status: session.status,
      step: session.step,
      thresholdPct: session.thresholdPct,
      outlierApplicationIds: session.outlierApplicationIds,
      currentApplicationId: session.currentApplicationId,
      createdByName: ADMIN.fullName,
      startedAt: new Date(STARTED).toISOString(),
      endedAt: session.endedAt,
    },
    viewer: { userId: viewer.id, isAdmin: viewer.role === "ADMIN", isHost: viewer.role === "ADMIN" && session.status === "ACTIVE" },
    participants: people,
    changeCount: changes.length,
  };
}

function teamView() {
  const { rows, ...rest } = stats(session.thresholdPct);
  return { version: session.version, group: { id: TEAM.id, name: TEAM.name }, members, ...rest };
}

function card(applicationId) {
  const s = stats(session.thresholdPct);
  const app = apps.find((a) => a.id === applicationId);
  const summary = s.candidates.find((c) => c.applicationId === applicationId);
  const memberIds = new Set(MEMBERS.map((m) => m.id));
  const docs = Object.fromEntries(["resume", "coverLetter", "video"].map((type) => [type, {
    has: true,
    max: MAX[type],
    categories: RUBRICS[type].categories.map(({ id, title, min, max }) => ({ id, title, min, max })),
    avg: summary.perDoc[type].avg,
    rows: s.rows
      .filter((r) => r.candidateId === app.candidateId && r.type === type)
      .map((r) => ({ ...r, onTeam: memberIds.has(r.evaluatorId) }))
      .sort((a, b) => a.evaluatorName.localeCompare(b.evaluatorName)),
  }]));
  return {
    version: session.version,
    applicationId,
    candidateId: app.candidateId,
    cycleId: "cycle-fall",
    name: app.name,
    major: app.major1,
    major2: null,
    year: app.graduationYear,
    gpa: app.cumulativeGpa,
    headshotUrl: null,
    resumeUrl: app.resumeUrl,
    coverLetterUrl: null,
    shortAnswer: app.shortAnswer,
    videoUrl: app.videoUrl,
    resumeDecision: app.resumeDecision,
    total: summary.total,
    outlierCount: summary.outlierCount,
    splitDocs: summary.splitDocs,
    docs,
  };
}

function nettedChanges() {
  const byKey = new Map();
  for (const c of changes) {
    const key = c.kind === "SCORE" ? `S:${c.scoreId}` : `D:${c.applicationId}`;
    if (byKey.has(key)) Object.assign(byKey.get(key), { toValue: c.toValue });
    else byKey.set(key, { ...c });
  }
  return { total: changes.length, changes: [...byKey.values()].filter((c) => c.fromValue !== c.toValue) };
}

// ---------- the Review Teams page ----------
const teamsList = () => [TEAM, ...OTHER_TEAMS].map((t) => {
  const ours = t.id === TEAM.id;
  const teamApps = ours ? apps : t.candidates.map((c, k) => ({ id: c.applicationId, name: `${t.name} applicant ${k + 1}` }));
  return {
    id: t.id,
    name: t.name,
    code: t.id.slice(-8),
    cycleId: "cycle-fall",
    cycleName: "Fall 2026",
    members: (ours ? MEMBERS : t.graders).map((m) => ({ id: m.id, name: m.fullName, fullName: m.fullName, email: m.email || `${m.id}@g.ucla.edu`, profileImage: null, avatar: null })),
    applications: teamApps.map((a) => ({
      id: a.id,
      candidateId: a.candidateId || a.id,
      name: a.name,
      major: a.major1 || "Economics",
      year: a.graduationYear || "2028",
      gpa: a.cumulativeGpa || "3.70",
      status: "SUBMITTED",
      resumeProgress: 100,
      coverLetterProgress: ours && a.id === "app-2" ? 67 : 100,
      videoProgress: 100,
      avatar: null,
      resumeOutliers: [],
      coverLetterOutliers: [],
      videoOutliers: [],
      hasOutliers: false,
    })),
  };
});

let docs;

export async function setup({ browser }) {
  docs = await makeSampleDocs(browser);
}

export async function api({ path, req, route, json }) {
  const method = req.method();
  const viewer = viewerOf(req);
  if (path === "/auth/verify") return json({ user: viewer });
  if (path === "/document-rubrics") return json(rubricResponse);
  if (path.startsWith("/review-teams/question-prompts")) return json({ shortAnswer: SHORT_ANSWER_PROMPT });
  if (path.startsWith("/review-teams/member-applications/")) return json([]);
  if (path === "/member/my-team") return json(null);
  // The member already has a Talent Network resume, so its setup prompt stays away.
  if (path === "/member/resume") return json({ resume: { id: "sample-resume" } });

  // Review Teams
  if (path === "/review-teams") return json(teamsList());
  if (path === "/review-teams/available-applications") return json([]);
  if (path === "/review-teams/users") return json(MEMBERS.map((m) => ({ ...m, role: "MEMBER" })));
  if (path === "/review-teams/contributions") return json([]);

  // Documents, through signed links as in production.
  if (/^\/files\/[^/]+\/link$/.test(path)) return json({ access: "sample-access" });
  if (path.startsWith("/files/")) {
    const video = path.includes("sample-video");
    return route.fulfill({ status: 200, contentType: video ? "video/mp4" : "application/pdf", body: readFileSync(video ? docs.video : docs.resume) });
  }

  // Review team deliberations
  if (path === "/review-delibs/groups") {
    if (!session) return json({ groups: [] });
    const open = session.status === "ACTIVE" ? { id: session.id, step: session.step, startedAt: new Date(STARTED).toISOString() } : null;
    const last = session.status === "ENDED" ? { id: session.id, endedAt: session.endedAt, changeCount: nettedChanges().changes.length } : null;
    return json({ groups: [{ groupId: TEAM.id, open, last }] });
  }
  if (path === "/review-delibs/active") {
    const live = session && session.status === "ACTIVE";
    return json({
      sessions: live
        ? [{ id: session.id, groupId: TEAM.id, groupName: TEAM.name, step: session.step, startedAt: new Date(STARTED).toISOString(), createdByName: ADMIN.fullName, joined: viewer.id === ADMIN.id }]
        : [],
    });
  }
  if (path === "/review-delibs" && method === "POST") {
    const { thresholdPct } = req.postDataJSON();
    session = { id: "delib-1", status: "ACTIVE", step: "OVERVIEW", currentApplicationId: null, thresholdPct, version: 1, endedAt: null };
    session.outlierApplicationIds = outlierOrder(stats(thresholdPct));
    return json({ session: { id: session.id, status: "ACTIVE", outlierCount: session.outlierApplicationIds.length } }, 201);
  }

  const m = /^\/review-delibs\/delib-1\/(.+)$/.exec(path);
  if (!m || !session) return false;
  const [action, ...rest] = m[1].split("/");
  if (action === "join" || action === "state") return json(state(viewer));
  if (action === "leave") return route.fulfill({ status: 204, body: "" });
  if (action === "team") return json(teamView());
  if (action === "candidates") return json(card(rest[0]));
  if (action === "changes") {
    const { total, changes: list } = nettedChanges();
    return json({
      total,
      changes: list.map((c) => ({ ...c, candidateName: apps.find((a) => a.id === c.applicationId).name, byName: ADMIN.fullName, at: new Date().toISOString() })),
    });
  }
  if (action === "navigate") {
    const { step, applicationId } = req.postDataJSON();
    session.step = step;
    session.currentApplicationId = step === "OUTLIERS"
      ? applicationId ?? session.outlierApplicationIds[0] ?? null
      : step === "ALL" ? applicationId ?? null : null;
    bump();
    return json(state(viewer));
  }
  if (action === "threshold") {
    const { thresholdPct } = req.postDataJSON();
    session.thresholdPct = thresholdPct;
    const order = outlierOrder(stats(thresholdPct));
    session.outlierApplicationIds = [...session.outlierApplicationIds, ...order.filter((id) => !session.outlierApplicationIds.includes(id))];
    bump();
    return json(state(viewer));
  }
  if (action === "scores") {
    const [type, scoreId] = rest;
    const { adminScore } = req.postDataJSON();
    const score = scores.find((s) => s.id === scoreId);
    const before = score.adminScore;
    score.adminScore = adminScore;
    const app = apps.find((a) => a.candidateId === score.candidateId);
    changes.push({
      id: `change-${changes.length + 1}`, kind: "SCORE", applicationId: app.id, docType: type, scoreId,
      graderName: score.evaluator.fullName, originalScore: score.overallScore,
      fromValue: before === null ? null : String(before), toValue: adminScore === null ? null : String(adminScore),
    });
    bump();
    await new Promise((r) => setTimeout(r, 200));
    return json(state(viewer));
  }
  if (action === "decision") {
    const { applicationId, decision } = req.postDataJSON();
    const app = apps.find((a) => a.id === applicationId);
    changes.push({ id: `change-${changes.length + 1}`, kind: "DECISION", applicationId, fromValue: app.resumeDecision, toValue: decision });
    app.resumeDecision = decision;
    bump();
    return json(state(viewer));
  }
  if (action === "end") {
    session.status = "ENDED";
    session.step = "SUMMARY";
    session.currentApplicationId = null;
    session.endedAt = new Date(STARTED + 9 * 60 * 1000 + 40 * 1000).toISOString();
    bump();
    return json(state(viewer));
  }
  return false;
}

export async function run({ page, base, browser, out, states, settle, pageState, viewState, elState }) {
  const dialog = () => page.locator(".MuiDialog-paper").last();
  const bar = () => page.locator(".MuiPaper-elevation6").last();
  const barTargets = () => ({
    bar: bar(),
    stepOverview: bar().getByRole("button", { name: "Overview" }),
    stepOutliers: bar().getByRole("button", { name: /^Outliers/ }),
    stepAll: bar().getByRole("button", { name: "All candidates" }).first(),
    stepSummary: bar().getByRole("button", { name: "Summary" }),
    next: bar().getByRole("button", { name: "Next" }),
    threshold: bar().locator(".MuiSelect-select"),
    end: bar().getByRole("button", { name: "End" }),
  });

  // ---------- Review Teams → Start delib ----------
  await page.goto(`${base}/review-teams`, { waitUntil: "networkidle" });
  // The admin's control bar is sticky. A full-page shot draws it where it sits in
  // the flow (after the content), but its box would be measured stuck to the
  // viewport bottom, so the video would aim at the wrong place. Pin it in place.
  await page.addStyleTag({ content: ".MuiPaper-elevation6 { position: static !important; }" });
  const teamCard = page.locator(".MuiPaper-root", { has: page.getByText(TEAM.name, { exact: true }) }).first();
  const start = teamCard.getByRole("button", { name: "Start delib" });
  await start.waitFor();
  await settle(800);
  await pageState("teams", { start, status: teamCard.getByText("Delib not held"), teamName: teamCard.getByText(TEAM.name, { exact: true }) });

  await start.click();
  await dialog().getByText(`Start ${TEAM.name} deliberation`).waitFor();
  await elState("launch", dialog(), {
    threshold: dialog().locator(".MuiSelect-select"),
    go: dialog().getByRole("button", { name: "Start and join" }),
  });

  // ---------- the overview ----------
  await dialog().getByRole("button", { name: "Start and join" }).click();
  await page.getByText("What stands out").waitFor();
  await settle(1200);
  await pageState("overview", {
    header: page.locator("h1", { hasText: TEAM.name }),
    tiles: page.locator(".MuiGrid-container").first(),
    insights: page.locator(".MuiPaper-root", { hasText: "What stands out" }).first(),
    flags: page.getByText("Needs correcting"),
    comparison: page.locator(".MuiPaper-root", { hasText: "Against the other teams" }).first(),
    graders: page.locator(".MuiPaper-root", { hasText: "Lean is how far" }).first(),
    ...barTargets(),
  });

  // ---------- a member's screen: the join prompt ----------
  const member = await memberBrowser({ browser, out, states });
  await member.page.goto(`${base}/document-grading`, { waitUntil: "networkidle" });
  const prompt = member.page.locator(".MuiDialog-paper", { hasText: "Your review team deliberation has started" });
  await prompt.waitFor({ timeout: 20000 });
  await member.shot("member-prompt", { prompt, join: prompt.getByRole("button", { name: "Join deliberation" }) });

  // ---------- outliers ----------
  // Widest disagreement first: Diego's short answer, split between two graders.
  await bar().getByRole("button", { name: /^Outliers/ }).click();
  await page.getByText(/^Outlier 1 of/).waitFor();
  await settle(1800); // the resume preview loads
  const scoreCell = (text) => page.locator("[data-testid^='score-']", { hasText: text }).first();
  await pageState("outlier-1", {
    card: page.locator(".MuiPaper-outlined", { hasText: /Outlier 1 of/ }).first(),
    scores: page.locator("section[aria-label='Resume scores']"),
    splitCell: scoreCell("Split"),
    docs: page.getByRole("tablist", { name: "Documents" }),
    decision: page.getByLabel("Resume Review decision"),
    ...barTargets(),
  });

  // Then one grader far below the other two, and the admin overrides it.
  await bar().getByRole("button", { name: "Next" }).click();
  await page.getByText(/^Outlier 2 of/).waitFor();
  await settle(1500);
  const outlier = scoreCell(/^(?!.*Resolved).*Outlier/);
  await pageState("outlier-2", { outlierCell: outlier, ...barTargets() });

  await outlier.getByRole("button", { name: /^Override/ }).click();
  const editing = page.locator("[data-testid^='score-']", { has: page.getByRole("spinbutton") });
  const input = editing.getByRole("spinbutton");
  await input.fill("10");
  await settle(300);
  await pageState("outlier-2-edit", { cell: editing, input, save: editing.getByRole("button", { name: "Save" }), ...barTargets() });
  await editing.getByRole("button", { name: "Save" }).click();
  await page.getByText("Resolved by override").first().waitFor();
  await settle(500);
  await pageState("outlier-2-done", { cell: scoreCell("Resolved by override"), ...barTargets() });

  // ---------- every candidate, and a decision ----------
  await bar().getByRole("button", { name: "All candidates" }).first().click();
  const table = page.getByRole("table", { name: "Candidates this team graded" });
  await table.waitFor();
  await settle(600);
  const tableRow = (name) => table.getByRole("row", { name: new RegExp(name) });
  await pageState("all", { table, theo: tableRow("Theo Nguyen"), ...barTargets() });

  await tableRow("Theo Nguyen").click();
  await page.getByRole("heading", { name: "Theo Nguyen" }).waitFor();
  await settle(1500);
  const decision = page.getByLabel("Resume Review decision");
  await pageState("all-open", { theo: tableRow("Theo Nguyen"), decision, card: page.getByRole("heading", { name: "Theo Nguyen" }), ...barTargets() });

  await decision.click();
  await settle(300);
  const menu = page.locator(".MuiMenu-paper, .MuiPopover-paper").last();
  await viewState("decision-menu", { menu, option: page.getByRole("option", { name: "Maybe Yes" }) });
  await page.getByRole("option", { name: "Maybe Yes" }).click();
  await settle(800);
  await pageState("all-decided", { theo: tableRow("Theo Nguyen"), decision, ...barTargets() });

  // ---------- the member sees the same card, without controls ----------
  await member.page.goto(`${base}/review-delib/delib-1`, { waitUntil: "networkidle" });
  await member.page.getByRole("heading", { name: "Theo Nguyen" }).waitFor({ timeout: 20000 }).catch(async (e) => {
    await member.page.screenshot({ path: join(out, "member-debug.png") });
    throw e;
  });
  await member.page.waitForTimeout(1500);
  await member.shot("member-card", {
    card: member.page.getByRole("heading", { name: "Theo Nguyen" }),
    decision: member.page.getByText(/^Resume Review: /),
  });
  await member.close();

  // ---------- summary and end ----------
  await bar().getByRole("button", { name: "Summary" }).click();
  await page.getByText("Summary so far").waitFor();
  await settle(600);
  await pageState("summary", { summary: page.locator(".MuiPaper-outlined", { hasText: "Summary so far" }).first(), end: bar().getByRole("button", { name: "End" }) });

  await bar().getByRole("button", { name: "End" }).click();
  await dialog().getByText("End this deliberation?").waitFor();
  await elState("end-confirm", dialog(), { confirm: dialog().getByRole("button", { name: "End deliberation" }) });
  await dialog().getByRole("button", { name: "End deliberation" }).click();
  await page.getByText("Deliberation finished").waitFor();
  await settle(600);
  await pageState("ended", { summary: page.locator(".MuiPaper-outlined", { hasText: "Deliberation finished" }).first() });
}

/**
 * A second browser, signed in as a member of the team and answered by the same
 * stub. Its screenshots are viewport states, like the harness's viewState.
 */
async function memberBrowser({ browser, out, states }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript((token) => {
    try {
      localStorage.setItem("token", token);
      localStorage.setItem("theme", "light");
    } catch {
      // a frame without storage
    }
  }, MEMBER_TOKEN);
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, "");
    let answered = false;
    const fulfill = (opts) => { answered = true; return route.fulfill(opts); };
    const json = (body, status = 200) => fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    await api({ path, req, route: { fulfill }, json });
    if (answered) return;
    if (path === "/live-votes/active") return json({ session: null });
    if (path === "/member/accountability") return json({ cycle: null, standing: null });
    if (path === "/member/events") return json([]);
    if (path.startsWith("/member/help/tutorial-gates/")) return json({ required: false, cycleId: "cycle-fall", tutorials: [] });
    if (path.startsWith("/analytics")) return route.fulfill({ status: 204, body: "" });
    return json({});
  });
  const page = await context.newPage();
  return {
    page,
    async shot(name, targets = {}) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(out, `${name}.png`) });
      const boxes = {};
      for (const [k, loc] of Object.entries(targets)) {
        if ((await loc.count()) === 0) continue;
        boxes[k] = await loc.first().boundingBox();
      }
      states[name] = { kind: "view", file: `review-delibs/${name}.png`, w: 1440, h: 900, boxes };
      console.log("view", name, "(member)");
    },
    close: () => context.close(),
  };
}
