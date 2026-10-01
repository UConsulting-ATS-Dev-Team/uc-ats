// Running a Coffee Chat: claim a sitting on Interview RSVP, find it in My
// Interviews, skim a resume, start the interview with your groups, take notes,
// pick a decision with the guide open, Save All, and see it under My
// Evaluations.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPS,
  claimed,
  CONFIG,
  DECISIONS,
  INTERVIEW,
  NOTES,
  SAMPLE_USER,
  SLOTS,
} from "../../src/videos/coffee-chats/sample-data.mjs";
import { makeSampleDocs } from "../sample-docs.mjs";

const root = join(import.meta.dirname, "../..");

/** The shipped decision guide, read out of the server so the video shows exactly it. */
function defaultGuide() {
  const src = readFileSync(join(root, "..", "server/src/services/decisionGuides.js"), "utf8");
  const head = "export const DEFAULT_GUIDE = ";
  const body = src.slice(src.indexOf(head) + head.length);
  const literal = body.slice(0, body.indexOf("\n});") + 3);
  return Function(`return (${literal});`)();
}
const GUIDE = defaultGuide();
const LABELS = { YES: "Yes", MAYBE_YES: "Maybe-Yes", MAYBE_NO: "Maybe-No", NO: "No" };
const guideResponse = {
  guide: {
    phase: "coffee",
    phaseLabel: "Coffee Chat",
    intro: GUIDE.intro,
    introSource: "default",
    decisions: Object.keys(LABELS).map((value) => ({ value, label: LABELS[value], criteria: GUIDE.criteria[value], source: "default" })),
    customized: false,
  },
  updatedAt: null,
};

let slots = structuredClone(SLOTS);
/** Saved evaluations, keyed by application id. */
const saved = {};
let docs;

const appsFor = (groupIds) => {
  const ids = new Set(CONFIG.applicationGroups.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.applicationIds));
  return APPS.filter((a) => ids.has(a.id));
};
const evaluationRows = () =>
  Object.values(saved).map((e) => {
    const a = APPS.find((x) => x.id === e.applicationId);
    return {
      id: `ev-${e.applicationId}`,
      interviewId: INTERVIEW.id,
      applicationId: e.applicationId,
      evaluatorId: SAMPLE_USER.id,
      notes: e.notes ?? "",
      decision: e.decision ?? null,
      behavioralNotes: {},
      casingNotes: null,
      candidateDetails: null,
      updatedAt: "2026-10-14T21:52:00.000Z",
      application: { ...a, candidate: { id: a.candidateId } },
    };
  });

export async function setup({ browser }) {
  docs = await makeSampleDocs(browser);
}

export async function api({ path, req, route, json, url }) {
  const method = req.method();
  if (path === "/auth/verify") return json({ user: SAMPLE_USER });
  if (path === "/member/resume") return json({ resume: { id: "sample-resume" } });
  if (path === "/member/profile") return json({ ...SAMPLE_USER, studentId: null, profileImage: null, createdAt: "2025-10-01T00:00:00.000Z" });

  // Interview RSVP
  if (path === "/member/interview-slots") return json({ interviews: [{ ...INTERVIEW, slots }] });
  if (path === "/member/interviews/open-for-availability") return json([]);
  if (path === "/member/interview-slots/s-pm/claim" && method === "POST") {
    slots = claimed(slots);
    await new Promise((r) => setTimeout(r, 200));
    return json({ overStaffed: false });
  }

  // My Interviews and the interview page
  if (path === "/member/interviews") return json([INTERVIEW]);
  if (path === `/member/interviews/${INTERVIEW.id}`) return json(INTERVIEW);
  if (path === `/member/interviews/${INTERVIEW.id}/config`) return json(CONFIG);
  if (path === `/member/interviews/${INTERVIEW.id}/applications`) {
    return json(appsFor((url.searchParams.get("groupIds") || "").split(",")));
  }
  if (path === "/member/evaluations" && method === "GET") return json(evaluationRows());
  if (path === "/member/evaluations" && method === "POST") {
    const body = req.postDataJSON();
    saved[body.applicationId] = { ...saved[body.applicationId], ...body };
    return json(evaluationRows().find((e) => e.applicationId === body.applicationId));
  }
  if (path === "/decision-guides/coffee") return json(guideResponse);

  // Interview chat: an empty conversation, so the launcher shows and nothing else.
  if (path === `/conversations/interviews/${INTERVIEW.id}`) {
    return json({ id: "conv-1", contextType: "INTERVIEW", contextId: INTERVIEW.id, title: INTERVIEW.title, channelName: "conv-1", participants: [] });
  }
  if (path === "/conversations/conv-1/messages") return json([]);
  if (path === "/conversations/conv-1/read") return json({ ok: true });

  if (path.startsWith("/files/")) {
    return route.fulfill({ status: 200, contentType: "application/pdf", body: readFileSync(docs.resume) });
  }
  return false;
}

export async function run({ page, base, states, settle, pageState, viewState, elState }) {
  const sidebar = (name) => page.locator(".sidebar a", { hasText: name });

  // ---------- 1. Interview RSVP: claim the afternoon sitting ----------
  await page.goto(`${base}/interview-rsvp`, { waitUntil: "networkidle" });
  await page.getByText("Coffee chat sittings").waitFor();
  await settle(800);
  const card = (label) => page.locator(".MuiCard-root", { hasText: label });
  const rsvpTargets = () => ({
    navRsvp: sidebar("Interview RSVP"),
    navMine: sidebar("My Interviews"),
    heading: page.getByText("Coffee chat sittings"),
    cardPm: card("Afternoon Session"),
    claimPm: card("Afternoon Session").getByRole("button", { name: "Sign up to run this" }),
    staffPm: card("Afternoon Session").getByText(/interviewers$/),
    notice: page.locator(".MuiAlert-root"),
    youChip: page.getByText("You're on this"),
  });
  await pageState("rsvp", rsvpTargets());
  await card("Afternoon Session").getByRole("button", { name: "Sign up to run this" }).click();
  await page.getByText("You're on this").waitFor();
  await page.mouse.move(0, 0);
  await settle(500);
  await pageState("rsvp-claimed", rsvpTargets());

  // ---------- 2. My Interviews ----------
  await sidebar("My Interviews").click();
  await page.getByRole("button", { name: /Start Interview/ }).waitFor();
  await settle(900);
  const groupRow = (label) => page.locator(".application-group-card", { hasText: label }).locator(".group-card-header");
  const mineTargets = () => ({
    card: page.locator(".interview-card, .interview-item").first(),
    badge: page.getByText("COFFEE CHAT").first(),
    assignment: page.getByText("Your Assignment").first(),
    groups: page.getByText("Assigned Application Groups").first(),
    group1: groupRow("· 1A"),
    start: page.getByRole("button", { name: /Start Interview/ }),
    resume1: page.locator(".candidate-card", { hasText: "Taylor Kim" }).getByRole("button", { name: "Resume" }),
    cand1: page.locator(".candidate-card", { hasText: "Taylor Kim" }),
    evals: page.getByText("My Evaluations").first(),
  });
  await pageState("mine", mineTargets());

  // ---------- 3. Skim a resume ----------
  await groupRow("· 1A").click();
  await page.locator(".candidate-card", { hasText: "Taylor Kim" }).waitFor();
  await settle(600);
  await pageState("mine-group", mineTargets());
  await page.locator(".candidate-card", { hasText: "Taylor Kim" }).getByRole("button", { name: "Resume" }).click();
  const previewClose = page.getByRole("button", { name: "Close", exact: true });
  await page.locator("iframe[title]").waitFor();
  await settle(2000); // the PDF renders inside the iframe
  const preview = previewClose.locator("xpath=../..");
  await elState("resume", preview, { close: previewClose });
  await previewClose.click();
  await settle(400);

  // ---------- 4. Start Interview: pick groups ----------
  await page.getByRole("button", { name: /Start Interview/ }).click();
  await page.getByText("Select Application Groups to Evaluate").waitFor();
  await settle(500);
  const picker = page.locator(".modal-content").last();
  const option = (label) => picker.locator(".group-selection-item", { hasText: label });
  const pickTargets = () => ({
    opt1: option("· 1A"),
    opt2: option("· 1B"),
    count: picker.getByText(/groups? selected/),
    go: picker.getByRole("button", { name: /^Start Interview/ }),
  });
  await elState("pick", picker, pickTargets());
  await option("· 1A").click();
  await elState("pick-1", picker, pickTargets());
  await option("· 1B").click();
  await page.mouse.move(0, 0);
  await elState("pick-2", picker, pickTargets());
  // The interview page for one group keeps the walkthrough to three cards.
  await option("· 1B").click();
  await page.mouse.move(0, 0);
  await elState("pick-3", picker, pickTargets());
  await picker.getByRole("button", { name: /^Start Interview/ }).click();

  // ---------- 5. The interview page ----------
  await page.getByText("About deliberation").waitFor();
  await settle(1200);
  const cardFor = (name) => page.locator(".application-card", { hasText: name });
  const faceTargets = () => ({
    header: page.locator(".interview-header"),
    saveAll: page.getByRole("button", { name: /Save All/ }),
    notice: page.getByText("About deliberation"),
    guideBtn: page.getByRole("button", { name: "What the decisions mean" }).first(),
    card1: cardFor("Taylor Kim"),
    notes1: cardFor("Taylor Kim").locator("textarea"),
    decide1: cardFor("Taylor Kim").locator(".decision-options"),
    yes1: cardFor("Taylor Kim").locator(".decision-option", { hasText: /^Yes$/ }),
    help1: cardFor("Taylor Kim").locator(".section-title button, .section-title [role=button]").first(),
    card2: cardFor("Sam Okafor"),
    notes2: cardFor("Sam Okafor").locator("textarea"),
    myes2: cardFor("Sam Okafor").locator(".decision-option", { hasText: "Maybe-Yes" }),
    card3: cardFor("Avery Chen"),
    chat: page.getByRole("button", { name: /open chat/i }),
  });
  await pageState("face", faceTargets());

  // Notes for the first candidate, a few characters per state.
  await cardFor("Taylor Kim").locator("textarea").click();
  await viewState("face-n-focus", faceTargets());
  const note = NOTES.a1;
  const step = 4;
  let n = 0;
  for (let at = 0; at < note.length; at += step) {
    await cardFor("Taylor Kim").locator("textarea").type(note.slice(at, at + step));
    await viewState(`face-n${n++}`, faceTargets());
  }
  states["face-notes"] = { count: n };

  // The decision guide drawer.
  await page.getByRole("button", { name: "What the decisions mean" }).first().click();
  const drawer = page.locator(".MuiDrawer-paper");
  await drawer.getByText("Decision guide").waitFor();
  await settle(700);
  await viewState("guide", { drawer, close: drawer.getByRole("button").first() });
  await page.keyboard.press("Escape");
  await settle(600);

  // Decide, then the other two (their notes appear between shots).
  await cardFor("Taylor Kim").locator(".decision-option", { hasText: /^Yes$/ }).click();
  await page.mouse.move(0, 0);
  await viewState("face-yes", faceTargets());
  await cardFor("Sam Okafor").locator("textarea").fill(NOTES.a2);
  await cardFor("Sam Okafor").locator(".decision-option", { hasText: "Maybe-Yes" }).click();
  await cardFor("Avery Chen").locator("textarea").fill(NOTES.a3);
  await cardFor("Avery Chen").locator(".decision-option", { hasText: /^Yes$/ }).click();
  await page.mouse.move(0, 0);
  await settle(2500); // let autosave land
  await pageState("face-all", faceTargets());

  // ---------- 6. Save All ----------
  await page.getByRole("button", { name: /Save All/ }).click();
  await page.getByText("All Evaluations Saved Successfully!").waitFor();
  await settle(500);
  const done = page.locator(".next-action-modal");
  await elState("saved", done, {
    another: done.getByRole("button", { name: /Interview Another Group/ }),
    back: done.getByRole("button", { name: /Back to Dashboard/ }),
  });
  await done.getByRole("button", { name: /Back to Dashboard/ }).click();

  // ---------- 7. Back on My Interviews: My Evaluations ----------
  await page.getByText("My Evaluations").first().waitFor();
  await page.getByText("Maybe-Yes").first().waitFor();
  await settle(900);
  const evalRow = (name) => page.locator(".evaluation-item, .evaluation-card", { hasText: name }).first();
  await pageState("mine-done", {
    ...mineTargets(),
    ev1: evalRow("Taylor Kim"),
    ev2: evalRow("Sam Okafor"),
    chip1: evalRow("Taylor Kim").getByText(/^Yes$/),
    chip2: evalRow("Sam Okafor").getByText("Maybe-Yes"),
    edit1: evalRow("Taylor Kim").getByRole("button").first(),
  });

  if (Object.keys(DECISIONS).some((id) => saved[id]?.decision !== DECISIONS[id])) {
    throw new Error(`the evaluations did not save as scripted: ${JSON.stringify(saved)}`);
  }
}
