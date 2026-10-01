// Running a Final Round: coordinate in the interview chat, take behavioral notes, run
// the case (exhibits, the interviewer-only guide, Candidate View, the casing rubric),
// confirm the candidate's details, Save All, then record the decision from My
// Interviews with the decision guide open.
//
// Edits are captured as viewport shots at recorded scroll positions; each tab is
// also captured as a full page, so the camera can scroll back to the tabs.
import { makeSampleDocs } from "../sample-docs.mjs";
import { makeSampleCase } from "../sample-case.mjs";
import { APPS, finalRoundApi, INTERVIEW, SAMPLE_USER, SHARED } from "../final-round-stubs.mjs";

const state = { as: "member", shared: [...SHARED], caseLocked: false, assignments: { a1: "case-1", a2: "case-1" } };
let handler;

export const SCRIPT = {
  reply: "On it. I've got Taylor.",
  q1: "Owned the disagreement, came back with data.",
  framework: "Split it into revenue, cost and risk for each option.",
};

export async function setup({ browser, context }) {
  // Interview day, during the session: the case is open.
  await context.clock.setFixedTime(new Date("2026-10-28T21:20:00.000Z"));
  const docs = await makeSampleDocs(browser);
  const casePages = await makeSampleCase(browser);
  handler = finalRoundApi({ docs, casePages, state });
}

export const api = (ctx) => handler(ctx);

export async function run({ page, base, states, settle, pageState, viewState, elState }) {
  await page.goto(`${base}/member/final-round-interview?interviewId=${INTERVIEW.id}&groupIds=room-f`, { waitUntil: "networkidle" });
  await page.getByText("Behavioral Assessment").first().waitFor();
  await settle(1500);

  const card1 = () => page.locator(".application-card", { hasText: "Taylor Kim" }).first();
  const tab = (name) => page.locator(".nav-tab", { hasText: name });
  const targets = () => ({
    tabs: page.locator(".nav-tabs"),
    tabCase: tab("Case Interview"),
    tabDetails: tab("Confirm Candidate Details"),
    saveAll: page.getByRole("button", { name: /Save All/ }),
    card1: card1(),
    q1: card1().getByPlaceholder("Your notes...").first(),
    launcher: page.getByRole("button", { name: "Open chat" }),
  });
  const scrollTo = async (locator, top) => {
    const y = await locator.evaluate((el, t) => Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY - t)), top);
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await settle(300);
    return y;
  };
  const typeStates = async (prefix, locator, text, step, t) => {
    let n = 0;
    for (let at = 0; at < text.length; at += step) {
      await locator.type(text.slice(at, at + step));
      await viewState(`${prefix}${n++}`, t());
    }
    states[`${prefix}count`] = { count: n };
  };

  // ---------- The page, and the chat ----------
  await pageState("b", targets());
  await page.getByRole("button", { name: "Open chat" }).click();
  const chatPanel = page.locator(".chat-widget-panel");
  await chatPanel.getByText("run the case for Sam").waitFor();
  await settle(400);
  const chatTargets = () => ({
    ...targets(),
    chatPanel,
    incoming: chatPanel.locator(".chat-message-row").first(),
    input: chatPanel.getByPlaceholder("Write a reply..."),
    send: chatPanel.getByRole("button", { name: "Send" }),
    sent: chatPanel.getByText(SCRIPT.reply),
  });
  await viewState("chat-open", chatTargets());
  await chatPanel.getByPlaceholder("Write a reply...").click();
  await typeStates("chat-t", chatPanel.getByPlaceholder("Write a reply..."), SCRIPT.reply, 4, chatTargets);
  await chatPanel.getByRole("button", { name: "Send" }).click();
  await chatPanel.getByText(SCRIPT.reply).waitFor();
  await page.mouse.move(0, 0);
  await viewState("chat-sent", chatTargets());
  await chatPanel.getByRole("button", { name: "Close chat" }).click();
  await settle(300);

  // ---------- Behavioral notes ----------
  states.notesScroll = { y: await scrollTo(card1().getByPlaceholder("Your notes...").first(), 420) };
  await viewState("b-notes", targets());
  await card1().getByPlaceholder("Your notes...").first().click();
  await typeStates("b-n", card1().getByPlaceholder("Your notes...").first(), SCRIPT.q1, 5, targets);
  await pageState("b-done", targets());

  // ---------- The case ----------
  await tab("Case Interview").click();
  await card1().locator(".case-viewer__img").first().waitFor();
  await settle(1500);
  const viewer = () => card1().locator(".case-viewer").first();
  const caseTargets = () => ({
    ...targets(),
    viewer: viewer(),
    image: viewer().locator(".case-viewer__img").first(),
    candidateView: viewer().getByRole("button", { name: /Candidate View/ }),
    ex1: viewer().getByRole("button", { name: "Exhibit 1" }).first(),
    next: viewer().getByRole("button", { name: "Next" }).first(),
    ioBadge: viewer().getByText(/Interviewer only/).first(),
    framework: card1().locator(".casing-section-row", { hasText: "Framework" }).locator("textarea"),
    rubric: card1().locator(".case-split__rubric").first(),
  });
  await pageState("c", caseTargets());
  states.caseScroll = { y: await scrollTo(viewer(), 110) };
  await viewState("c-1", caseTargets());
  await viewer().getByRole("button", { name: "Exhibit 1" }).first().click();
  await settle(700);
  await page.mouse.move(0, 0);
  await viewState("c-ex1", caseTargets());
  await viewer().getByRole("button", { name: "Next" }).first().click();
  await settle(600);
  await viewState("c-ex2", caseTargets());
  await viewer().getByRole("button", { name: "Next" }).first().click();
  await viewer().getByText(/Interviewer only/).first().waitFor();
  await settle(600);
  await page.mouse.move(0, 0);
  await viewState("c-io", caseTargets());

  // Candidate View: full screen, interviewer-only pages left out.
  await viewer().getByRole("button", { name: "Exhibit 1" }).first().click();
  await settle(500);
  await viewer().getByRole("button", { name: /Candidate View/ }).click();
  const overlay = page.locator(".case-preview-overlay").first();
  await overlay.waitFor();
  await settle(900);
  await page.mouse.move(0, 0);
  await viewState("c-cand", { exit: page.locator(".case-preview-overlay__exit") });
  await page.locator(".case-preview-overlay__exit").click();
  await settle(600);

  // The casing rubric.
  const fw = card1().locator(".casing-section-row", { hasText: "Framework" }).locator("textarea");
  await fw.click();
  await typeStates("c-f", fw, SCRIPT.framework, 6, caseTargets);
  await pageState("c-done", caseTargets());

  // ---------- Candidate details ----------
  await tab("Confirm Candidate Details").click();
  await card1().getByText(/Confirm phone number/).waitFor();
  await settle(600);
  const box = (re) => card1().locator(".logistical-label", { hasText: re }).locator("input");
  const detailTargets = () => ({
    ...targets(),
    phone: box(/Confirm phone number/),
    tonight: box(/decision tonight/),
    meetings: box(/Weekly mandatory meetings/),
    list: card1().locator(".logistical-label").first(),
  });
  await pageState("d", detailTargets());
  states.detailsScroll = { y: await scrollTo(card1().getByText(/Confirm phone number/), 380) };
  await viewState("d-0", detailTargets());
  const checks = [/Confirm phone number/, /decision tonight/, /Weekly mandatory meetings/];
  for (let i = 0; i < checks.length; i++) {
    await box(checks[i]).check();
    await page.mouse.move(0, 0);
    await viewState(`d-${i + 1}`, detailTargets());
  }
  await pageState("d-done", detailTargets());

  // ---------- Save All ----------
  await page.getByRole("button", { name: /Save All/ }).click();
  await settle(800);
  // Everything the video shows being entered must be in the save it shows.
  const saved = state.saves.filter((s) => s.applicationId === "a1").at(-1);
  const details = saved?.candidateDetails ?? {};
  const savedAll =
    Object.values(saved?.behavioralNotes ?? {}).includes(SCRIPT.q1) &&
    saved?.casingNotes?.framework === SCRIPT.framework &&
    details.phoneConfirmed && details.decisionCallTonight && details.weeklyMeetings;
  if (!savedAll) throw new Error(`Save All did not send the scripted evaluation: ${JSON.stringify(saved)}`);

  // ---------- The decision, from My Interviews ----------
  const app1 = APPS[0];
  state.evaluations = APPS.map((a) => {
    const s = state.saves.filter((x) => x.applicationId === a.id).at(-1) || {};
    return {
      id: `ev-${a.id}`,
      interviewId: INTERVIEW.id,
      applicationId: a.id,
      evaluatorId: SAMPLE_USER.id,
      notes: "",
      decision: null,
      behavioralNotes: s.behavioralNotes ?? {},
      casingNotes: s.casingNotes ?? null,
      candidateDetails: s.candidateDetails ?? null,
      updatedAt: "2026-10-28T22:05:00.000Z",
      application: { ...a, candidate: { id: a.candidateId } },
    };
  });
  await page.goto(`${base}/assigned-interviews`, { waitUntil: "networkidle" });
  await page.getByText("My Evaluations").first().waitFor();
  await settle(900);
  const evalRow = () => page.locator(".evaluation-item", { hasText: app1.name }).first();
  const mineTargets = () => ({
    evals: page.getByText("My Evaluations").first(),
    row1: evalRow(),
    chip1: evalRow().getByText(/Not evaluated|^Yes$/).first(),
    edit1: evalRow().getByRole("button", { name: /Edit evaluation/ }),
  });
  await pageState("m", mineTargets());
  await evalRow().getByRole("button", { name: /Edit evaluation/ }).click();
  await page.getByText("Edit Evaluation").waitFor();
  await settle(500);
  const modal = () => page.locator(".modal-content").last();
  const modalTargets = () => ({
    yes: modal().locator("label", { hasText: /^Yes$/ }).first(),
    help: modal().getByRole("button", { name: /What the decisions mean/ }).first(),
    save: modal().getByRole("button", { name: /Save Changes/ }),
  });
  await elState("m-edit", modal(), modalTargets());
  await modal().getByRole("button", { name: /What the decisions mean/ }).first().click();
  const drawer = page.locator(".MuiDrawer-paper");
  await drawer.getByText("Decision guide").waitFor();
  await settle(600);
  await viewState("m-guide", { drawer });
  await page.keyboard.press("Escape");
  await settle(500);
  await modal().locator("label", { hasText: /^Yes$/ }).first().click();
  await page.mouse.move(0, 0);
  await elState("m-yes", modal(), modalTargets());
  await modal().getByRole("button", { name: /Save Changes/ }).click();
  await page.getByText("Edit Evaluation").waitFor({ state: "detached" });
  await settle(700);
  await pageState("m-done", mineTargets());

  const decided = state.saves.at(-1);
  if (decided?.decision !== "YES" || decided.applicationId !== "a1") throw new Error(`decision not saved: ${JSON.stringify(decided)}`);
  if (state.chat.messages.at(-1)?.body !== SCRIPT.reply) throw new Error("the chat reply was not sent");
}
