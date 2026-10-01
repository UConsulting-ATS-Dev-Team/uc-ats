// Stub answers more than one capture flow needs.
import { expect, readServerConstant } from "./server-source.mjs";

const DECISIONS_FILE = "server/src/services/decisionGuides.js";

/** GET /decision-guides/:phase, built from the shipped default guide. */
export function decisionGuideResponse(phase, phaseLabel) {
  const labels = readServerConstant(DECISIONS_FILE, "DECISION_LABELS", (l) =>
    expect(["YES", "MAYBE_YES", "MAYBE_NO", "NO"].every((k) => typeof l?.[k] === "string"), "DECISION_LABELS"),
  );
  const guide = readServerConstant(DECISIONS_FILE, "DEFAULT_GUIDE", (g) => {
    expect(typeof g?.intro === "string" && g.intro.length > 0, "DEFAULT_GUIDE.intro");
    expect(Object.keys(labels).every((k) => typeof g.criteria?.[k] === "string"), "DEFAULT_GUIDE.criteria");
  });
  return {
    guide: {
      phase,
      phaseLabel,
      intro: guide.intro,
      introSource: "default",
      decisions: Object.keys(labels).map((value) => ({ value, label: labels[value], criteria: guide.criteria[value], source: "default" })),
      customized: false,
    },
    updatedAt: null,
  };
}

/**
 * The interview chat with nobody talking yet, so its launcher shows and nothing
 * else. Answers the three calls the widget makes; returns false for anything else.
 */
export function emptyInterviewChat(path, json, interview) {
  if (path === `/conversations/interviews/${interview.id}`) {
    return json({ id: "conv-1", contextType: "INTERVIEW", contextId: interview.id, title: interview.title, channelName: "conv-1", participants: [] });
  }
  if (path === "/conversations/conv-1/messages") return json([]);
  if (path === "/conversations/conv-1/read") return json({ ok: true });
  return false;
}
