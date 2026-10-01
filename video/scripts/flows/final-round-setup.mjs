// Setting Up a Final Round, in two parts.
//   Admin: the case library and its time restriction, then a case for each candidate.
//   Interviewer: Start Interview with the room, write the behavioral questions, then
//   on the final round page read Round One history, and find the case still locked.
import { makeSampleDocs } from "../sample-docs.mjs";
import { makeSampleCase } from "../sample-case.mjs";
import { APPS, finalRoundApi, INTERVIEW, SHARED } from "../final-round-stubs.mjs";

const state = { as: "admin", shared: [], caseLocked: true, unlocksAt: "2026-10-28T19:00:00.000Z" };
let handler;

export async function setup({ browser, context }) {
  // Interview day, 10 a.m.: with the default 2-hour window the case unlocks at noon,
  // so the locked panel reads "about 2 hours" rather than counting from today.
  await context.clock.setFixedTime(new Date("2026-10-28T17:00:00.000Z"));
  const docs = await makeSampleDocs(browser);
  const casePages = await makeSampleCase(browser);
  handler = finalRoundApi({ docs, casePages, state });
}

export const api = (ctx) => handler(ctx);

export async function run({ page, base, states, settle, pageState, elState }) {
  const sidebar = (name) => page.locator(".sidebar a", { hasText: name });
  const menu = () => page.locator(".MuiMenu-paper, .MuiPopover-paper").last();

  // ---------- Admin: the case library ----------
  await page.goto(`${base}/cases`, { waitUntil: "networkidle" });
  await page.getByText("Case book time restriction").waitFor();
  await settle(800);
  const libTargets = () => ({
    navCases: sidebar("Cases"),
    card: page.locator(".MuiPaper-root", { hasText: "Case book time restriction" }).first(),
    hours: page.getByLabel("Hours before"),
    table: page.locator("table").first(),
    westwood: page.locator("tr", { hasText: "Westwood Coffee Co." }).first(),
    upload: page.getByRole("button", { name: /Upload New Case/ }),
    tabAsg: page.getByRole("tab", { name: "Assignments" }),
  });
  await pageState("lib", libTargets());

  // ---------- Admin: assign a case to each candidate ----------
  await page.getByRole("tab", { name: "Assignments" }).click();
  await page.getByText("Select a final-round interview to assign cases.").waitFor();
  await settle(500);
  const asgTargets = () => ({
    tabAsg: page.getByRole("tab", { name: "Assignments" }),
    pickInterview: page.getByLabel("Final-round interview"),
    row1: page.locator("tr", { hasText: "Taylor Kim" }).first(),
    row2: page.locator("tr", { hasText: "Sam Okafor" }).first(),
    case1: page.locator("tr", { hasText: "Taylor Kim" }).first().getByRole("combobox"),
    case2: page.locator("tr", { hasText: "Sam Okafor" }).first().getByRole("combobox"),
    status1: page.locator("tr", { hasText: "Taylor Kim" }).first().locator(".MuiChip-root"),
    status2: page.locator("tr", { hasText: "Sam Okafor" }).first().locator(".MuiChip-root"),
  });
  await pageState("asg", asgTargets());
  await page.getByLabel("Final-round interview").click();
  await settle(400);
  await elState("asg-menu", menu(), { option: page.getByRole("option", { name: new RegExp(INTERVIEW.title) }) });
  await page.getByRole("option", { name: new RegExp(INTERVIEW.title) }).click();
  await page.locator("tr", { hasText: "Taylor Kim" }).waitFor();
  await page.mouse.move(0, 0);
  await settle(600);
  await pageState("asg-list", asgTargets());
  for (const [i, name] of APPS.map((a, j) => [j + 1, a.name])) {
    await page.locator("tr", { hasText: name }).first().getByRole("combobox").click();
    await settle(400);
    await elState(`asg-case-menu${i}`, menu(), { option: page.getByRole("option", { name: "Westwood Coffee Co." }) });
    await page.getByRole("option", { name: "Westwood Coffee Co." }).click();
    await page.locator("tr", { hasText: name }).first().getByText("Assigned").waitFor();
    await page.mouse.move(0, 0);
    await settle(400);
    await pageState(`asg-${i}`, asgTargets());
  }

  // ---------- Interviewer: My Interviews ----------
  state.as = "member";
  await page.goto(`${base}/assigned-interviews`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Start Interview/ }).waitFor();
  await settle(900);
  await pageState("mine", {
    navMine: sidebar("My Interviews"),
    badge: page.getByText("FINAL ROUND").first(),
    title: page.getByText(INTERVIEW.title).first(),
    start: page.getByRole("button", { name: /Start Interview/ }),
  });
  await page.getByRole("button", { name: /Start Interview/ }).click();
  await page.getByText("Select Application Groups to Evaluate").waitFor();
  await settle(500);
  const modal = () => page.locator(".modal-content").last();
  const option = () => modal().locator(".group-selection-item").first();
  const go = () => modal().getByRole("button", { name: /^Start Interview|Configure Questions/ });
  await elState("pick", modal(), { opt1: option(), count: modal().getByText(/selected/), go: go() });
  await option().click();
  await page.mouse.move(0, 0);
  await elState("pick-1", modal(), { opt1: option(), count: modal().getByText(/selected/), go: go() });
  await go().click();

  // ---------- Interviewer: behavioral questions ----------
  await page.getByText("Configure Behavioral Questions").waitFor();
  await settle(500);
  const setupTargets = () => ({
    intro: modal().locator(".config-instruction"),
    add: modal().getByRole("button", { name: /Add (First|Another) Question/ }),
    q1: modal().getByPlaceholder("Behavioral Question 1"),
    q2: modal().getByPlaceholder("Behavioral Question 2"),
    go: go(),
  });
  await elState("setup", modal(), setupTargets());
  for (let i = 0; i < SHARED.length; i++) {
    await modal().getByRole("button", { name: /Add (First|Another) Question/ }).click();
    const input = modal().getByPlaceholder(`Behavioral Question ${i + 1}`);
    await input.click();
    let n = 0;
    for (let at = 0; at < SHARED[i].length; at += 5) {
      await input.type(SHARED[i].slice(at, at + 5));
      await elState(`setup-q${i + 1}-${n++}`, modal(), setupTargets());
    }
    states[`setup-q${i + 1}-count`] = { count: n };
  }
  await go().click();

  // ---------- Interviewer: the final round page ----------
  await page.getByText("Behavioral Assessment").first().waitFor();
  await page.getByRole("button", { name: /Round One history/ }).first().waitFor();
  await settle(1200);
  const card1 = () => page.locator(".application-card", { hasText: "Taylor Kim" }).first();
  const frTargets = () => ({
    tabs: page.locator(".nav-tabs"),
    tabCase: page.locator(".nav-tab", { hasText: "Case Interview" }),
    card1: card1(),
    history: card1().getByRole("button", { name: /Round One history/ }),
    historyBody: card1().getByText(/not a transcript/).first(),
    q1: card1().getByText(SHARED[0]).first(),
    locked: page.getByText("Case opens closer to the interview").first(),
    lockedWhen: page.getByText(/unlocks in/).first(),
  });
  await pageState("fr", frTargets());
  await card1().getByRole("button", { name: /Round One history/ }).click();
  await card1().getByText(/not a transcript/).first().waitFor();
  await page.mouse.move(0, 0);
  await settle(500);
  await pageState("fr-history", frTargets());

  await page.locator(".nav-tab", { hasText: "Case Interview" }).click();
  await page.getByText("Case opens closer to the interview").first().waitFor();
  await page.mouse.move(0, 0);
  await settle(600);
  await pageState("fr-locked", frTargets());

  if (state.shared.length !== SHARED.length) throw new Error(`questions not saved: ${JSON.stringify(state.shared)}`);
}
