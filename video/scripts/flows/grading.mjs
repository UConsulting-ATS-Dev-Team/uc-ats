// Document Grading 101: grade a resume, a short answer and a video, flag a
// broken document, and reach the all-done celebration.
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_APPS, SAMPLE_USER } from "../../src/videos/grading/sample-data.mjs";
import { makeSampleDocs } from "../sample-docs.mjs";
import { expect, readServerConstant } from "../server-source.mjs";

const root = join(import.meta.dirname, "../..");
// ---------- sample API ----------
// The shipped default rubrics, read out of the server so the video can never show a
// rubric that differs from them.
const RUBRICS = readServerConstant("server/src/services/documentRubrics.js", "DEFAULT_RUBRICS", (r) => {
  for (const type of ["resume", "coverLetter", "video"]) {
    expect(Array.isArray(r?.[type]?.categories) && r[type].categories.length > 0, `DEFAULT_RUBRICS.${type}.categories`);
    for (const c of r[type].categories) expect(Number.isFinite(c.min) && Number.isFinite(c.max), `${type} category min/max`);
  }
});
const AGG = { resume: "sum", coverLetter: "average", video: "single" };
const overall = (type, key) =>
  RUBRICS[type].categories.reduce((s, c) => s + c[key], 0) / (AGG[type] === "average" ? RUBRICS[type].categories.length : 1);
const rubricResponse = {
  rubrics: Object.fromEntries(
    Object.keys(RUBRICS).map((type) => [
      type,
      { type, aggregation: AGG[type], rubric: RUBRICS[type], minOverall: overall(type, "min"), maxOverall: overall(type, "max"), customized: false, updatedAt: null },
    ]),
  ),
  types: ["resume", "coverLetter", "video"],
  participationMax: 3,
  stagingMax: 21,
};

let apps = structuredClone(SAMPLE_APPS);
const SCORE_FLAG = { "resume-score": "hasResumeScore", "cover-letter-score": "hasCoverLetterScore", "video-score": "hasVideoScore" };


// The criteria rows the typed scores light up (DocumentGradingModal gives the
// row that applies an outline), as hl0, hl1, ...
const litRows = async (el, b) => {
  const lit = await el.evaluate((root) =>
    [...root.querySelectorAll("li")]
      .filter((n) => parseFloat(getComputedStyle(n).outlineWidth) > 0 && getComputedStyle(n).outlineStyle !== "none")
      .map((n) => n.getBoundingClientRect().toJSON()),
  );
  return Object.fromEntries(lit.map((r, i) => [`hl${i}`, { x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height }]));
};

let docs;

export async function setup({ browser }) {
  docs = await makeSampleDocs(browser);
  // The video plays the same clip over the player while it "plays".
  copyFileSync(docs.video, join(root, "public/sample-video.mp4"));
}

export async function api({ path, req, route, json }) {
  if (path === "/auth/verify") return json({ user: SAMPLE_USER });
  if (path.startsWith("/review-teams/member-applications/")) return json(apps);
  if (path === "/document-rubrics") return json(rubricResponse);
  if (path === "/member/resume") return json({ resume: { id: "sample-resume" } });
  if (path === "/member/my-team")
    return json({
      id: "sample-team",
      name: "Review Team 4",
      code: "RT4",
      members: [
        { id: SAMPLE_USER.id, name: SAMPLE_USER.fullName, email: SAMPLE_USER.email },
        { id: "m2", name: "Priya Shah", email: "priya.shah@g.ucla.edu" },
        { id: "m3", name: "Marcus Bell", email: "marcus.bell@g.ucla.edu" },
      ],
      applications: apps,
    });
    // Applicant 3's resume is broken, so the flag step has a reason to exist.
  if (path.includes("sample-resume-3")) return json({ error: "File not found" }, 500);
  if (path.startsWith("/files/")) {
    const file = path.endsWith(".mp4") ? docs.video : docs.resume;
    return route.fulfill({ status: 200, contentType: path.endsWith(".mp4") ? "video/mp4" : "application/pdf", body: readFileSync(file) });
  }
  const score = /^\/review-teams\/(resume-score|cover-letter-score|video-score)/.exec(path);
  if (score && req.method() === "GET") return json({ error: "Not found" }, 404);
  if (score && req.method() === "POST") {
    const { candidateId } = req.postDataJSON();
    apps = apps.map((a) => (a.candidateId === candidateId ? { ...a, [SCORE_FLAG[score[1]]]: true } : a));
    await new Promise((r) => setTimeout(r, 250));
    return json({ ok: true });
  }
  if (path === "/member/flag-document" && req.method() === "POST") {
    const { applicationId, candidateId, documentType, reason } = req.postDataJSON();
    apps = apps.map((a) =>
      a.id === applicationId || a.candidateId === candidateId ? { ...a, [`${documentType}Flagged`]: { reason } } : a,
    );
    return json({ ok: true });
  }
  return false;
}

// Errors the app logs on this path by design: a document with no score yet answers
// 404, and the broken resume is served broken to show "Failed to load preview".
export const EXPECTED_ERRORS = [/Error loading existing score: .*Not found \(Status: 404\)/, /Failed to load resume preview: .*File not found/];

export async function run({ page, base, states, settle, pageState, viewState, elState: elStateRaw }) {
  const elState = (name, el, targets = {}) => elStateRaw(name, el, targets, litRows);
  // ---------- dashboard → Document Grading ----------
  await page.goto(`${base}/dashboard`, { waitUntil: "networkidle" });
  await page.getByText("Grade Resumes").waitFor();
  await settle(800);
  const navGrading = page.locator(".sidebar a", { hasText: "Document Grading" });
  await viewState("dashboard", { navGrading });
  
  await navGrading.click();
  await page.getByText("Start Grading").waitFor();
  await settle(900);
  
  const tab = (name) => page.getByRole("tab", { name });
  const rows = () => page.locator("tbody tr");
  const rowTargets = () => ({
    startGrading: page.getByText("Start Grading"),
    progress: page.locator(".MuiPaper-root").nth(1),
    table: page.locator("table"),
    tabResumes: tab("Resumes"),
    tabShort: tab("Short Answers"),
    tabVideos: tab("Videos"),
    doc1: rows().nth(0).locator("button").first(),
    flag1: rows().nth(0).locator(".MuiIconButton-root"),
    status1: rows().nth(0).locator(".MuiChip-root"),
    doc3: rows().nth(2).locator("button").first(),
    flag3: rows().nth(2).locator(".MuiIconButton-root"),
    status3: rows().nth(2).locator(".MuiChip-root"),
    row1: rows().nth(0),
    row3: rows().nth(2),
  });
  await pageState("grading", rowTargets());
  
  // ---------- resume ----------
  const dialog = () => page.locator(".MuiDialog-paper").last();
  const inputs = () => dialog().locator("input");
  const modalTargets = () => ({
    field1: inputs().nth(0),
    field2: inputs().nth(1),
    field3: inputs().nth(2),
    notes: dialog().locator("textarea").first(),
    save: dialog().getByRole("button", { name: /Save Score|Saving/ }),
    close: dialog().getByRole("button", { name: "Close" }),
    rubric: dialog().getByText("Grading Rubric"),
    footer: dialog().getByRole("heading", { name: /^Overall [0-9]/ }),
    player: dialog().locator("video, iframe").first(),
    alert: dialog().getByText("Score saved successfully!"),
  });
  const modalTargetsFor = async (count) => {
    const t = modalTargets();
    if (count < 3) delete t.field3;
    if (count < 2) delete t.field2;
    return t;
  };
  
  async function gradeFlow(prefix, docButton, values, note, fieldCount) {
    await docButton.click();
    await page.getByText("Grading Rubric").waitFor();
    await settle(1500); // PDF / video preview loads
    await elState(`${prefix}-open`, dialog(), await modalTargetsFor(fieldCount));
    for (let i = 0; i < values.length; i++) {
      await inputs().nth(i).click();
      await elState(`${prefix}-f${i + 1}`, dialog(), await modalTargetsFor(fieldCount));
      await inputs().nth(i).type(String(values[i]));
      await page.mouse.move(0, 0);
      await elState(`${prefix}-v${i + 1}`, dialog(), await modalTargetsFor(fieldCount));
    }
    if (note) {
      const notes = dialog().locator("textarea").first();
      await notes.scrollIntoViewIfNeeded();
      await elState(`${prefix}-ns`, dialog(), await modalTargetsFor(fieldCount));
      await notes.click();
      await elState(`${prefix}-nf`, dialog(), await modalTargetsFor(fieldCount));
      const step = 3;
      let n = 0;
      for (let at = 0; at < note.length; at += step) {
        await notes.type(note.slice(at, at + step));
        await elState(`${prefix}-n${n++}`, dialog(), await modalTargetsFor(fieldCount));
      }
      states[`${prefix}-notes`] = { count: n };
    }
    await dialog().getByRole("button", { name: "Save Score" }).click();
    await dialog().getByText("Score saved successfully!").waitFor();
    // The alert sits above the categories; scroll the rubric back up to it.
    await dialog().getByText("Grading Rubric").evaluate((el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = 0;
      }
    });
    await elState(`${prefix}-saved`, dialog(), await modalTargetsFor(fieldCount));
    await page.locator(".MuiDialog-root").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await settle(800);
  }
  
  await gradeFlow("resume", rows().nth(0).locator("button").first(), [8, 3], "Strong impact metrics. Clean layout.", 2);
  await pageState("grading-r1done", rowTargets());
  
  // ---------- short answer ----------
  await tab("Short Answers").click();
  await settle(500);
  await pageState("short", rowTargets());
  await gradeFlow("short", rows().nth(0).locator("button").first(), [3, 2, 3], "", 3);
  await pageState("short-done", rowTargets());
  
  // ---------- video ----------
  await tab("Videos").click();
  await settle(500);
  await pageState("video", rowTargets());
  await gradeFlow("video", rows().nth(0).locator("button").first(), [2], "", 1);
  await pageState("video-done", rowTargets());
  
  // ---------- flag ----------
  await tab("Resumes").click();
  await settle(500);
  await pageState("flagtab", rowTargets());
  // Open the broken one first: the modal's own "Failed to load preview" state.
  await rows().nth(2).locator("button").first().click();
  await dialog().getByText("Failed to load preview").waitFor();
  await elState("broken-open", dialog(), {
    close: dialog().getByRole("button", { name: "Close" }),
    newtab: dialog().getByText(/in new tab/),
    failed: dialog().getByText("Failed to load preview"),
  });
  await dialog().getByRole("button", { name: "Close" }).click();
  await page.locator(".MuiDialog-root").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await settle(500);
  await rows().nth(2).locator(".MuiIconButton-root").click();
  await settle(600);
  const select = dialog().locator(".MuiSelect-select").first();
  const flagButton = () => dialog().getByRole("button", { name: /Flag Document|Flagging/ });
  await elState("flag-open", dialog(), { select, submit: flagButton() });
  await select.click();
  await settle(400);
  const menu = page.locator(".MuiMenu-paper, .MuiPopover-paper").last();
  const option = page.getByRole("option", { name: "Technical issues" });
  await elState("flag-menu", menu, { option });
  states["flag-menu"].dialogRel = { x: states["flag-menu"].x - states["flag-open"].x, y: states["flag-menu"].y - states["flag-open"].y };
  await option.click();
  await page.mouse.move(0, 0);
  await elState("flag-picked", dialog(), { select, submit: flagButton() });
  await flagButton().click();
  await dialog().getByText("Document flagged successfully!").waitFor();
  await elState("flag-done", dialog(), { submit: flagButton() });
  await page.locator(".MuiDialog-root").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await settle(800);
  await pageState("flagged", rowTargets());
  
  // ---------- everything graded: the celebration ----------
  apps = apps.map((a) => ({ ...a, hasResumeScore: true, hasCoverLetterScore: true, hasVideoScore: true }));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Congratulations!").waitFor({ timeout: 10000 });
  await settle(3500); // the app's own confetti stops after 3s; the video draws its own
  const celebrate = page.locator(".MuiDialog-paper").last();
  await elState("celebrate", celebrate, { button: celebrate.getByRole("button") });
  // The page behind it, without the dialog, for the bars filling to 100%.
  await page.addStyleTag({ content: ".MuiDialog-root { display: none !important; }" });
  await pageState("alldone", { progress: page.locator(".MuiPaper-root").nth(1) });
}
