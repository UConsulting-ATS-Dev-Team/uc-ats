// Setting Up a First Round: open the interview in My Interviews, read a candidate's
// resume, Start Interview with the room's group, add the questions everyone is asked,
// add one for a single candidate from their resume, and land on the first round page
// with both in place.
import { readFileSync } from "node:fs";
import { APPS, CONFIG, FOR_TAYLOR, INTERVIEW, SAMPLE_USER, SHARED } from "../../src/videos/first-round-setup/sample-data.mjs";
import { makeSampleDocs } from "../sample-docs.mjs";
import { decisionGuideResponse, emptyInterviewChat } from "../stubs.mjs";

const guideResponse = decisionGuideResponse("firstRound", "First Round");

/** Shared questions per group id, as PATCH /config saved them. */
const shared = {};
/** Candidate questions per application id. */
const forCandidate = {};
let docs;

const behavioralQuestions = (groupIds) =>
  Object.fromEntries(
    groupIds.map((g) => [
      g,
      (shared[g] || []).map((text, i) => ({
        id: `bq-${g}-${i}`,
        text,
        order: i,
        groupId: g,
        createdBy: { id: SAMPLE_USER.id, fullName: SAMPLE_USER.fullName },
        createdAt: "2026-10-19T18:00:00.000Z",
      })),
    ]),
  );

export async function setup({ browser }) {
  docs = await makeSampleDocs(browser);
}

export async function api({ path, req, route, json, url }) {
  const method = req.method();
  if (path === "/auth/verify") return json({ user: SAMPLE_USER });
  if (path === "/member/resume") return json({ resume: { id: "sample-resume" } });
  if (path === "/member/profile") return json({ ...SAMPLE_USER, studentId: null, profileImage: null, createdAt: "2025-10-01T00:00:00.000Z" });
  // The first round page tries the admin profile first and falls back for members.
  if (path === "/admin/profile") return json({ error: "Forbidden" }, 403);

  const base = `/member/interviews/${INTERVIEW.id}`;
  if (path === "/member/interviews") return json([INTERVIEW]);
  if (path === base) return json(INTERVIEW);
  if (path === `${base}/config` && method === "GET") {
    const ids = (url.searchParams.get("groupIds") || "").split(",").filter(Boolean);
    return json(ids.length ? { ...CONFIG, behavioralQuestions: behavioralQuestions(ids) } : CONFIG);
  }
  if (path === `${base}/config` && method === "PATCH") {
    const { config } = req.postDataJSON();
    shared[config.groupId] = config.questions;
    return json({ success: true, message: "Behavioral questions updated successfully" });
  }
  if (path === `${base}/applications`) return json(APPS);
  if (path === `${base}/candidate-questions` && method === "GET") {
    const ids = (url.searchParams.get("applicationIds") || "").split(",");
    return json(Object.fromEntries(ids.map((id) => [id, forCandidate[id] || []])));
  }
  if (path === `${base}/candidate-questions` && method === "POST") {
    const { applicationId, questionText } = req.postDataJSON();
    const list = (forCandidate[applicationId] ||= []);
    const q = {
      id: `cq-${applicationId}-${list.length}`,
      text: questionText,
      order: list.length,
      applicationId,
      groupId: "room2",
      createdBy: { id: SAMPLE_USER.id, fullName: SAMPLE_USER.fullName },
      createdAt: "2026-10-19T18:05:00.000Z",
      updatedAt: "2026-10-19T18:05:00.000Z",
    };
    list.push(q);
    await new Promise((r) => setTimeout(r, 150));
    return json(q);
  }
  if (path === "/member/evaluations") return json([]);
  if (path === "/decision-guides/firstRound") return json(guideResponse);
  if (path.startsWith(`${base}/session-questions`)) return json([]);
  if (path.startsWith(`${base}/question-bank`)) return json(path.endsWith("facets") ? { categories: [], rounds: [] } : []);
  if (emptyInterviewChat(path, json, INTERVIEW)) return;

  if (path.startsWith("/files/")) {
    return route.fulfill({ status: 200, contentType: "application/pdf", body: readFileSync(docs.resume) });
  }
  return false;
}

export async function run({ page, base, states, settle, pageState, viewState, elState }) {
  const sidebar = (name) => page.locator(".sidebar a", { hasText: name });

  // ---------- 1. My Interviews ----------
  await page.goto(`${base}/assigned-interviews`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Start Interview/ }).waitFor();
  await settle(900);
  const groupRow = page.locator(".application-group-card").first().locator(".group-card-header");
  const cand = (name) => page.locator(".candidate-card", { hasText: name });
  const mineTargets = () => ({
    navMine: sidebar("My Interviews"),
    badge: page.getByText("ROUND ONE").first(),
    title: page.getByText(INTERVIEW.title).first(),
    groups: page.getByText("Assigned Application Groups").first(),
    group1: groupRow,
    start: page.getByRole("button", { name: /Start Interview/ }),
    cand1: cand("Taylor Kim"),
    resume1: cand("Taylor Kim").getByRole("button", { name: "Resume" }),
  });
  await pageState("mine", mineTargets());

  // ---------- 2. Read the resume ----------
  await groupRow.click();
  await cand("Taylor Kim").waitFor();
  await settle(600);
  await pageState("mine-group", mineTargets());
  await cand("Taylor Kim").getByRole("button", { name: "Resume" }).click();
  const previewClose = page.getByRole("button", { name: "Close", exact: true });
  await page.locator("iframe[title]").waitFor();
  await settle(2200);
  const preview = previewClose.locator("xpath=../..");
  await elState("resume", preview, { close: previewClose, frame: page.locator("iframe[title]") });
  await previewClose.click();
  await settle(400);

  // ---------- 3. Start Interview, pick the room ----------
  await page.getByRole("button", { name: /Start Interview/ }).click();
  await page.getByText("Select Application Groups to Evaluate").waitFor();
  await settle(500);
  const modal = () => page.locator(".modal-content").last();
  const option = () => modal().locator(".group-selection-item").first();
  const go = () => modal().getByRole("button", { name: /^Start Interview|Configure Questions/ });
  await elState("pick", modal(), { opt1: option(), go: go() });
  await option().click();
  await page.mouse.move(0, 0);
  await elState("pick-1", modal(), { opt1: option(), go: go() });
  await go().click();

  // ---------- 4. Shared questions ----------
  await page.getByText("Configure Behavioral Questions").waitFor();
  await page.getByText("Taylor Kim").last().waitFor();
  await settle(600);
  const setupTargets = () => ({
    intro: modal().locator(".config-instruction"),
    add: modal().getByRole("button", { name: /Add (First|Another) Question/ }),
    q1: modal().getByPlaceholder("Behavioral Question 1"),
    q2: modal().getByPlaceholder("Behavioral Question 2"),
    perHead: modal().getByText("Questions for specific candidates"),
    taylor: modal().locator(".candidate-question-setup__toggle", { hasText: "Taylor Kim" }),
    taylorInput: modal().getByPlaceholder("Add a question for Taylor"),
    taylorAdd: modal().locator(".candidate-questions__add-btn"),
    taylorSaved: modal().locator(".candidate-questions__text").first(),
    go: go(),
  });
  await elState("setup", modal(), setupTargets());
  const typeInto = async (prefix, locator, text, step = 4) => {
    let n = 0;
    for (let at = 0; at < text.length; at += step) {
      await locator.type(text.slice(at, at + step));
      await elState(`${prefix}${n++}`, modal(), setupTargets());
    }
    states[`${prefix}count`] = { count: n };
  };
  for (let i = 0; i < SHARED.length; i++) {
    await modal().getByRole("button", { name: /Add (First|Another) Question/ }).click();
    await modal().getByPlaceholder(`Behavioral Question ${i + 1}`).click();
    await elState(`setup-q${i + 1}-focus`, modal(), setupTargets());
    await typeInto(`setup-q${i + 1}-`, modal().getByPlaceholder(`Behavioral Question ${i + 1}`), SHARED[i]);
  }

  // ---------- 5. A question for Taylor ----------
  await modal().locator(".candidate-question-setup__toggle", { hasText: "Taylor Kim" }).click();
  await modal().getByPlaceholder("Add a question for Taylor").waitFor();
  await modal().getByPlaceholder("Add a question for Taylor").scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await elState("setup-taylor", modal(), setupTargets());
  await modal().getByPlaceholder("Add a question for Taylor").click();
  await typeInto("setup-t-", modal().getByPlaceholder("Add a question for Taylor"), FOR_TAYLOR, 6);
  await modal().locator(".candidate-questions__add-btn").click();
  await modal().locator(".candidate-questions__text").first().waitFor();
  await page.mouse.move(0, 0);
  await elState("setup-taylor-saved", modal(), setupTargets());

  // ---------- 6. Configure Questions: into the first round page ----------
  await go().click();
  await page.getByText("Suggested Itinerary").waitFor();
  await settle(1500);
  await pageState("room", {
    header: page.locator(".interview-header, header").first(),
    rotation: page.getByText("Behaviorals").first(),
    q1Head: page.getByText(SHARED[0]).first(),
    candHead: page.getByText("Candidate-Specific").first(),
    taylorQ: page.getByText(FOR_TAYLOR).first(),
    row1: page.locator(".grid-row", { hasText: "Taylor Kim" }).first(),
  });

  if (!shared.room2 || shared.room2.length !== SHARED.length || (forCandidate.a1 || []).length !== 1) {
    throw new Error(`setup did not save as scripted: ${JSON.stringify({ shared, forCandidate })}`);
  }
  // And the page shows them: both shared questions and Taylor's own, on Taylor's row.
  const taylorRow = page.locator(".grid-row", { hasText: "Taylor Kim" }).first();
  for (const text of [...SHARED, FOR_TAYLOR]) {
    if (!(await taylorRow.getByText(text).first().isVisible())) {
      throw new Error(`Taylor's row on the first round page does not show "${text}"`);
    }
  }
}
