// "What happens next" after an interview: your decision is a recommendation, stored
// against the candidate, and Staging is where admins advance or reject (the decision
// guide's own words: DEFAULT_GUIDE in server/src/services/decisionGuides.js). Each
// round's video words the first card and the closing line for itself.
import { interpolate, useCurrentFrame } from "remotion";
import { Card, Pop } from "./Bits";
import { clamp, Exit, Sub, Title } from "./Explainer";
import { Stage } from "./Light";
import { C, LIGHT } from "./theme";

const DECISION_CHIPS = [
  { label: "Yes", color: "#15803d", bg: "#dcfce7" },
  { label: "Maybe-Yes", color: "#166534", bg: "#ecfdf5" },
  { label: "Maybe-No", color: "#c2410c", bg: "#ffedd5" },
  { label: "No", color: "#b91c1c", bg: "#fee2e2" },
];

export type RecommendationCopy = {
  /** Under "You" on the first card. */
  youBody: string;
  /** The muted line under the cards, and which of its words are blue. */
  sub: string;
  subAccent: number[];
};

export function Recommendation({ youBody, sub, subAccent }: RecommendationCopy) {
  const frame = useCurrentFrame();
  const end = 185;
  const steps = [
    { head: "You", body: youBody, at: 26 },
    { head: "It's a recommendation", body: "stored against the candidate", at: 62 },
    { head: "Staging", body: "is where admins advance or reject", at: 98 },
  ];
  const flow = (i: number) => interpolate(frame, [steps[i].at + 18, steps[i].at + 34], [0, 1], clamp);
  return (
    <Stage>
      <Title kicker="What happens next" text="Your decision is a recommendation" accent={[4]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 360, display: "flex", justifyContent: "center", alignItems: "center", gap: 30 }}>
          {steps.map((s, i) => (
            <div key={s.head} style={{ display: "flex", alignItems: "center", gap: 30 }}>
              <Pop at={s.at} y={80}>
                <Card style={{ width: 430, height: 330, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, padding: 30 }}>
                  {i === 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10, width: 330 }}>
                      {DECISION_CHIPS.map((d, j) => (
                        <Pop key={d.label} at={s.at + 8 + j * 4} y={10}>
                          <span style={{ fontSize: 22, fontWeight: 800, color: d.color, background: d.bg, borderRadius: 999, padding: "6px 16px", display: "inline-block" }}>
                            {d.label}
                          </span>
                        </Pop>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 64, fontWeight: 800, color: C.blue, lineHeight: 1 }}>{i === 1 ? "→" : "✓"}</div>
                  )}
                  <div style={{ fontSize: 34, fontWeight: 800, textAlign: "center" }}>{s.head}</div>
                  <div style={{ fontSize: 24, fontWeight: 600, color: LIGHT.muted, textAlign: "center", lineHeight: 1.3 }}>{s.body}</div>
                </Card>
              </Pop>
              {i < steps.length - 1 && (
                <div style={{ width: 60, height: 6, borderRadius: 3, background: C.blue, opacity: flow(i), transform: `scaleX(${flow(i)})`, transformOrigin: "0 50%" }} />
              )}
            </div>
          ))}
        </div>
        <Sub text={sub} accent={subAccent} at={132} exitAt={end} top={790} />
      </Exit>
    </Stage>
  );
}
