// The explainer beats around the review team deliberation walkthrough.
//
// Every rule stated here comes from the code:
// - A session is one review team plus admins; members of other teams never see
//   it, and the admin running it moves everyone's screen (canWatch and navigate
//   in server/src/services/reviewDelibs/reviewDelibs.js).
// - The steps are Overview, Outliers, All candidates, Summary (STEPS there).
// - An outlier is a grade at least 30% of the document's max from the other
//   graders' mean, and further from them than anyone else's; a wide gap with no
//   single culprit is a split (compare() in teamStats.js; the 30% default is
//   DEFAULT_THRESHOLD_PCT and the admin can change it in the session).
// - An override is the score row's adminScore: the grader's own score stays, and
//   clearing the override restores it (overrideScore).
// - Decisions are Staging's Resume Review decision, written by the same
//   saveRoundDecision as Staging's picker (setDecision).
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Card, Pop } from "../../kit/Bits";
import { Exit, Sub, Title } from "../../kit/Explainer";
import { Stage } from "../../kit/Light";
import { C, LIGHT } from "../../kit/theme";

const RED = "#d32f2f";
const AMBER = "#ed6c02";

// ---------- 1. How it works ----------

const STEPS = [
  { n: "1", title: "Overview", body: "How the team graded, against the other teams" },
  { n: "2", title: "Outliers", body: "Each disagreement, widest first" },
  { n: "3", title: "All candidates", body: "Anyone else worth a second look" },
];

export function HowItWorks() {
  const end = 230;
  return (
    <Stage>
      <Title kicker="Review team delibs" text="Ten minutes. One team. One shared screen." accent={[0, 1, 5, 6]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 360, display: "flex", justifyContent: "center", gap: 36 }}>
          {STEPS.map((step, i) => (
            <Pop key={step.n} at={24 + i * 14} y={70}>
              <Card style={{ width: 430, height: 270, padding: "34px 36px" }}>
                <div
                  style={{
                    width: 56, height: 56, borderRadius: "50%", background: C.blue, color: "#fff",
                    fontSize: 30, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {step.n}
                </div>
                <div style={{ fontSize: 38, fontWeight: 800, marginTop: 24 }}>{step.title}</div>
                <div style={{ fontSize: 24, fontWeight: 600, color: LIGHT.muted, marginTop: 10, lineHeight: 1.35 }}>{step.body}</div>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub
          text="An admin drives. The team follows along on their own screens."
          accent={[1, 2, 4, 5, 6]}
          at={96}
          exitAt={end}
          top={720}
        />
      </Exit>
    </Stage>
  );
}

// ---------- 2. Outliers and splits ----------

/** One document's grades as dots on 0..max, the flagged ones coloured. */
function Strip({ label, max, grades, at }: { label: string; max: number; grades: { v: number; who: string; flag?: "outlier" | "split" }[]; at: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const W = 640;
  const p = (i: number) => spring({ frame: frame - (at + 10 + i * 6), fps, config: { damping: 14, stiffness: 140 } });
  const mark = spring({ frame: frame - (at + 46), fps, config: { damping: 16, stiffness: 120 } });
  return (
    <Pop at={at} y={60}>
      <Card style={{ width: 760, padding: "28px 40px 36px" }}>
        <div style={{ fontSize: 28, fontWeight: 800 }}>{label}</div>
        <div style={{ position: "relative", width: W, height: 120, marginTop: 20 }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: 58, height: 4, borderRadius: 2, background: "#dbe2ea" }} />
          <div style={{ position: "absolute", left: 0, top: 80, fontSize: 20, color: LIGHT.muted, fontWeight: 600 }}>0</div>
          <div style={{ position: "absolute", right: 0, top: 80, fontSize: 20, color: LIGHT.muted, fontWeight: 600 }}>{max}</div>
          {grades.map((g, i) => {
            const color = g.flag === "outlier" ? RED : g.flag === "split" ? AMBER : C.navy;
            const flagged = g.flag ? mark : 0;
            return (
              <div key={i} style={{ position: "absolute", left: (g.v / max) * W - 18, top: 42, opacity: p(i), transform: `scale(${0.5 + 0.5 * p(i)})` }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: flagged > 0.5 ? color : C.navy, border: "4px solid #fff", boxShadow: "0 0 0 1px rgba(4,39,66,0.12)" }} />
                <div style={{ position: "absolute", top: -36, left: -40, width: 116, textAlign: "center", fontSize: 18, fontWeight: 700, color: LIGHT.muted }}>{g.who}</div>
                {g.flag && (
                  <div
                    style={{
                      position: "absolute", top: 48, left: -34, width: 104, textAlign: "center",
                      fontSize: 18, fontWeight: 800, color: "#fff", background: color, borderRadius: 12, padding: "2px 0",
                      opacity: flagged, transform: `translateY(${(1 - flagged) * 10}px)`,
                    }}
                  >
                    {g.flag === "outlier" ? "Outlier" : "Split"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </Pop>
  );
}

export function Outliers() {
  const end = 275;
  return (
    <Stage>
      <Title kicker="What gets flagged" text="An outlier is one grade far from the rest" accent={[1, 5]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 300, display: "flex", justifyContent: "center", gap: 40 }}>
          <Strip
            label="Resume · out of 13"
            max={13}
            at={18}
            grades={[{ v: 3, who: "Jordan", flag: "outlier" }, { v: 8, who: "Marcus" }, { v: 10.5, who: "Priya" }]}
          />
          <Strip
            label="Short answer · out of 3"
            max={3}
            at={70}
            grades={[{ v: 1, who: "Marcus", flag: "split" }, { v: 3, who: "Priya", flag: "split" }]}
          />
        </div>
        <Sub
          text="Far means 30% of the max or more. When nobody is clearly the odd one out, it's a split."
          accent={[2, 3, 4, 5, 18]}
          at={130}
          exitAt={end}
          top={720}
        />
      </Exit>
    </Stage>
  );
}

// ---------- 3. After ----------

const OUTCOMES = [
  { title: "Overrides", body: "The grader's own score is kept. Clear the override to put it back.", color: C.blue },
  { title: "Decisions", body: "Land on Staging's Resume Review tab straight away.", color: C.navy },
];

export function After() {
  const end = 200;
  return (
    <Stage>
      <Title kicker="When you're done" text="Every change is already live" accent={[3, 4]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 340, display: "flex", justifyContent: "center", gap: 40 }}>
          {OUTCOMES.map((o, i) => (
            <Pop key={o.title} at={22 + i * 16} y={60}>
              <Card style={{ width: 600, height: 230, padding: "34px 40px", borderTop: `8px solid ${o.color}` }}>
                <div style={{ fontSize: 40, fontWeight: 800 }}>{o.title}</div>
                <div style={{ fontSize: 27, fontWeight: 600, color: LIGHT.muted, marginTop: 14, lineHeight: 1.35 }}>{o.body}</div>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub text="Nothing to export, nothing to copy over." accent={[0, 3]} at={84} exitAt={end} top={660} />
      </Exit>
    </Stage>
  );
}
