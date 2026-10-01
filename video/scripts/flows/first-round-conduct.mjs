// Running a First Round: the first round page with questions already set up. Comment on
// each answer and the candidate's own question, score Behaviorals, pull a question from
// the bank, move to Market Sizing, then Post Grading: decide with the guide open, note
// why, and Save All.
//
// Edits in the grid are captured as viewport shots at one scroll position (gridScroll,
// recorded in states.json); each rotation is also captured as a full page before and
// after its edits, so the video can scroll back up to Next Rotation.
import { readFileSync } from "node:fs";
import { APPS, CONFIG, FOR_TAYLOR, INTERVIEW, SAMPLE_USER, SHARED } from "../../src/videos/first-round-setup/sample-data.mjs";
import { makeSampleDocs } from "../sample-docs.mjs";
import { decisionGuideResponse, interviewChat } from "../stubs.mjs";

const guideResponse = decisionGuideResponse("firstRound", "First Round");

/** The interview chat: Priya, in the same room, splits the note-taking. */
export const CHAT_REPLY = "Deal, I've got Taylor's.";
const chat = interviewChat({
  interview: INTERVIEW,
  me: SAMPLE_USER,
  colleague: { id: "m-priya", fullName: "Priya Shah", email: "priya.shah@g.ucla.edu" },
  opening: "I'll take Market Sizing notes for Sam and Avery. Can you take Taylor's?",
});

const BANK = [
  {
    id: "qb-1",
    prompt: "Walk us through a decision you made with incomplete information.",
    guidance: "Listen for how they weighed the risk, not the outcome.",
    round: "ROUND_ONE",
    category: "Judgment",
  },
  {
    id: "qb-2",
    prompt: "Tell us about a time you changed someone's mind.",
    guidance: "Did they listen first?",
    round: "ROUND_ONE",
    category: "Influence",
  },
];

/** What the interviewer writes for Taylor, per field. */
export const SCRIPT = {
  q1: "Owned the miss, rebuilt the volunteer rota.",
  own: "Shadowed volunteers for a week to find it.",
  scores: { leadership: "4", problem: "4", interest: "5" },
  market: "Clean top-down structure; sanity-checked against campus size.",
  marketScores: { teamwork: "4", logic: "5", creativity: "3" },
  post: "Strong all round. Push on structure in final.",
};

const sessionQuestions = [];
let docs;
const saves = [];

export async function setup({ browser }) {
  docs = await makeSampleDocs(browser);
}

export async function api({ path, req, route, json }) {
  const method = req.method();
  if (path === "/auth/verify") return json({ user: SAMPLE_USER });
  if (path === "/member/resume") return json({ resume: { id: "sample-resume" } });
  if (path === "/member/profile") return json({ ...SAMPLE_USER, studentId: null, profileImage: null, createdAt: "2025-10-01T00:00:00.000Z" });
  if (path === "/admin/profile") return json({ error: "Forbidden" }, 403);

  const base = `/member/interviews/${INTERVIEW.id}`;
  if (path === base) return json(INTERVIEW);
  if (path === `${base}/config`) {
    return json({
      ...CONFIG,
      behavioralQuestions: {
        room2: SHARED.map((text, i) => ({ id: `bq-${i}`, text, order: i, groupId: "room2", createdBy: { id: SAMPLE_USER.id, fullName: SAMPLE_USER.fullName } })),
      },
    });
  }
  if (path === `${base}/applications`) return json(APPS);
  if (path === `${base}/candidate-questions`) {
    return json({
      a1: [{ id: "cq-a1-0", text: FOR_TAYLOR, order: 0, applicationId: "a1", groupId: "room2", createdBy: { id: SAMPLE_USER.id, fullName: SAMPLE_USER.fullName } }],
      a2: [],
      a3: [],
    });
  }
  if (path === "/member/evaluations" && method === "GET") return json([]);
  if (path === "/member/evaluations" && method === "POST") {
    saves.push(req.postDataJSON());
    return json({ id: `f-${saves.length}` });
  }
  if (path === "/decision-guides/firstRound") return json(guideResponse);

  if (path.startsWith(`${base}/session-questions/bank`) && method === "POST") {
    const { questionId } = req.postDataJSON();
    const q = BANK.find((b) => b.id === questionId);
    const row = { id: `sq-${sessionQuestions.length}`, interviewId: INTERVIEW.id, prompt: q.prompt, guidance: q.guidance, questionBankId: q.id, position: sessionQuestions.length, updatedAt: new Date().toISOString(), deletedAt: null };
    sessionQuestions.push(row);
    return json(row, 201);
  }
  if (path.startsWith(`${base}/session-questions`)) return json(sessionQuestions);
  if (path === `${base}/question-bank/facets`) return json({ categories: ["Influence", "Judgment"], rounds: ["ROUND_ONE"] });
  if (path.startsWith(`${base}/question-bank`)) return json(BANK);
  if (chat.handle(path, json, req)) return;

  if (path.startsWith("/files/")) {
    return route.fulfill({ status: 200, contentType: "application/pdf", body: readFileSync(docs.resume) });
  }
  return false;
}

export async function run({ page, base, states, settle, pageState, viewState }) {
  await page.goto(`${base}/member/first-round-interview?interviewId=${INTERVIEW.id}&groupIds=room2`, { waitUntil: "networkidle" });
  await page.getByText("Suggested Itinerary").waitFor();
  await settle(1200);

  const row = (name) => page.locator(".grid-row", { hasText: name }).first();
  const taylor = () => row("Taylor Kim");
  const selects = () => taylor().locator("select");
  const targets = () => ({
    tracker: page.locator(".progress-tracker"),
    next: page.getByRole("button", { name: /Next Rotation/ }),
    itinerary: page.locator(".suggested-itinerary"),
    saveAll: page.getByRole("button", { name: /Save All/ }),
    header: page.locator(".grid-header").first(),
    row1: taylor(),
    q1: taylor().getByPlaceholder("Comments").first(),
    own: taylor().getByLabel(`Notes: ${FOR_TAYLOR}`),
    ownQ: taylor().getByText(FOR_TAYLOR).first(),
    s1: selects().nth(0),
    s2: selects().nth(1),
    s3: selects().nth(2),
    total: taylor().locator(".score-total").first(),
    market: taylor().getByPlaceholder("Market Sizing Notes"),
    notice: page.getByText("About deliberation"),
    guideBtn: page.getByRole("button", { name: "What the decisions mean" }).first(),
    myes: taylor().locator(".decision-option", { hasText: "Maybe-Yes" }),
    yes: taylor().locator(".decision-option", { hasText: /^Yes$/ }),
    post: taylor().getByPlaceholder("Post Grading Notes"),
    qtab: page.getByRole("button", { name: "Interview questions" }),
    launcher: page.getByRole("button", { name: "Open chat" }),
  });

  // Where the grid sits for every edit: its header just under the top bar.
  const gridScroll = await page.evaluate(() => {
    const header = document.querySelector(".grid-header");
    return Math.round(header.getBoundingClientRect().top + window.scrollY - 90);
  });
  states.gridScroll = { y: gridScroll };
  const toGrid = async () => {
    await page.evaluate((y) => window.scrollTo(0, y), gridScroll);
    await settle(250);
  };
  // The grid scrolls sideways inside its own container; the score columns are past
  // the right edge until it does.
  const gridToScores = async () => {
    await page.locator(".applications-grid-container").first().evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await settle(250);
  };
  const typeStates = async (prefix, locator, text, step, targetsFor = targets) => {
    let n = 0;
    for (let at = 0; at < text.length; at += step) {
      await locator.type(text.slice(at, at + step));
      await viewState(`${prefix}${n++}`, targetsFor());
    }
    states[`${prefix}count`] = { count: n };
  };

  // ---------- Rotation 1: Behaviorals ----------
  await pageState("r1", targets());
  await toGrid();
  await taylor().getByPlaceholder("Comments").first().click();
  await typeStates("r1-c", taylor().getByPlaceholder("Comments").first(), SCRIPT.q1, 5);
  await taylor().getByLabel(`Notes: ${FOR_TAYLOR}`).click();
  await typeStates("r1-k", taylor().getByLabel(`Notes: ${FOR_TAYLOR}`), SCRIPT.own, 6);
  const scores = [SCRIPT.scores.leadership, SCRIPT.scores.problem, SCRIPT.scores.interest];
  await gridToScores();
  await viewState("r1-scores", targets());
  for (let i = 0; i < 3; i++) {
    await selects().nth(i).selectOption(scores[i]);
    await page.mouse.move(0, 0);
    await viewState(`r1-s${i + 1}`, targets());
  }

  // The question bank, from the Questions tab.
  await page.getByRole("button", { name: "Interview questions" }).click();
  const panel = page.locator("aside.question-panel");
  await panel.waitFor();
  await settle(500);
  const panelTargets = () => ({
    ...targets(),
    panel,
    bankTab: panel.getByRole("tab", { name: /Question bank/ }),
    add1: panel.getByRole("button", { name: `Add: ${BANK[0].prompt}` }),
    added1: panel.getByRole("button", { name: `Already added: ${BANK[0].prompt}` }),
    close: panel.getByRole("button", { name: "Close questions" }),
  });
  await viewState("panel", panelTargets());
  await panel.getByRole("tab", { name: /Question bank/ }).click();
  await panel.getByText(BANK[0].prompt).waitFor();
  await settle(400);
  await viewState("panel-bank", panelTargets());
  await panel.getByRole("button", { name: `Add: ${BANK[0].prompt}` }).click();
  await panel.getByRole("button", { name: `Already added: ${BANK[0].prompt}` }).waitFor();
  await page.mouse.move(0, 0);
  await viewState("panel-added", panelTargets());
  await panel.getByRole("button", { name: "Close questions" }).click();
  await settle(400);

  // The interview chat: everyone staffing this interview, in one conversation.
  await page.getByRole("button", { name: "Open chat" }).click();
  const chatPanel = page.locator(".chat-widget-panel");
  await chatPanel.getByText("Market Sizing notes for Sam").waitFor();
  await settle(500);
  const chatTargets = () => ({
    ...targets(),
    launcher: page.getByRole("button", { name: "Open chat" }),
    chatPanel,
    incoming: chatPanel.locator(".chat-message-row").first(),
    input: chatPanel.getByPlaceholder("Write a reply..."),
    send: chatPanel.getByRole("button", { name: "Send" }),
    sent: chatPanel.getByText(CHAT_REPLY),
  });
  await viewState("chat-open", chatTargets());
  await chatPanel.getByPlaceholder("Write a reply...").click();
  await typeStates("chat-t", chatPanel.getByPlaceholder("Write a reply..."), CHAT_REPLY, 4, chatTargets);
  await chatPanel.getByRole("button", { name: "Send" }).click();
  await chatPanel.getByText(CHAT_REPLY).waitFor();
  await page.mouse.move(0, 0);
  await settle(300);
  await viewState("chat-sent", chatTargets());
  await chatPanel.getByRole("button", { name: "Close chat" }).click();
  await settle(300);
  await pageState("r1-done", targets());

  // ---------- Rotation 2: Market Sizing ----------
  await page.getByRole("button", { name: /Next Rotation/ }).click();
  await settle(700);
  await pageState("r2", targets());
  await toGrid();
  await taylor().getByPlaceholder("Market Sizing Notes").click();
  await typeStates("r2-m", taylor().getByPlaceholder("Market Sizing Notes"), SCRIPT.market, 7);
  const mscores = [SCRIPT.marketScores.teamwork, SCRIPT.marketScores.logic, SCRIPT.marketScores.creativity];
  await gridToScores();
  await viewState("r2-scores", targets());
  for (let i = 0; i < 3; i++) {
    await selects().nth(i).selectOption(mscores[i]);
    await page.mouse.move(0, 0);
    await viewState(`r2-s${i + 1}`, targets());
  }
  await pageState("r2-done", targets());

  // ---------- Rotation 3: Post Grading ----------
  await page.getByRole("button", { name: /Next Rotation/ }).click();
  await settle(700);
  await pageState("r3", targets());
  await toGrid();
  await viewState("r3-grid", targets());
  // Where the guide button is clicked from: the grid position if the button shows
  // there, else scrolled until it clears the fixed top bar. The video clicks it from
  // this exact view (r3-guidebtn).
  const guideBtn = page.getByRole("button", { name: "What the decisions mean" }).first();
  const top = await guideBtn.evaluate((el) => el.getBoundingClientRect().top);
  if (top < 100 || top > 820) {
    await guideBtn.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 300));
    await settle(250);
  }
  states.guideScroll = { y: await page.evaluate(() => Math.round(window.scrollY)) };
  await viewState("r3-guidebtn", targets());
  await page.getByRole("button", { name: "What the decisions mean" }).first().click();
  const drawer = page.locator(".MuiDrawer-paper");
  await drawer.getByText("Decision guide").waitFor();
  await settle(700);
  await viewState("guide", { drawer });
  await page.keyboard.press("Escape");
  await settle(500);
  await toGrid();
  await taylor().locator(".decision-option", { hasText: "Maybe-Yes" }).click();
  await page.mouse.move(0, 0);
  await viewState("r3-decided", targets());
  await taylor().getByPlaceholder("Post Grading Notes").click();
  await typeStates("r3-p", taylor().getByPlaceholder("Post Grading Notes"), SCRIPT.post, 5);
  await pageState("r3-done", targets());

  // ---------- Save All ----------
  await page.getByRole("button", { name: /Save All/ }).click();
  await settle(800);

  if (chat.messages.at(-1)?.body !== CHAT_REPLY) throw new Error("the chat reply was not sent");
  const last = saves.filter((s) => s.applicationId === "a1").at(-1);
  const ok =
    last &&
    last.decision === "MAYBE_YES" &&
    last.notes === SCRIPT.post &&
    last.behavioralTotal === 13 &&
    last.marketSizingTotal === 12 &&
    last.marketSizingNotes === SCRIPT.market;
  if (!ok) throw new Error(`Save All did not send the scripted evaluation: ${JSON.stringify(last)}`);
}
