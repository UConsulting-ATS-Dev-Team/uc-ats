// The explainer beats around the first round walkthrough.
//
// Every rule stated here comes from the code (FirstRoundInterviewInterface.jsx):
// - The suggested itinerary is Intros 0-5, Behaviorals 5-35, Market Size 35-50,
//   Present 50-52 and Questions 52-60 minutes, timed from when the page opens, with a
//   countdown on Behaviorals and Market Size.
// - The page has three rotations: Behaviorals (comments per question, Leadership /
//   Problem Solving / Interest 1-5), Market Sizing (notes, Teamwork / Logic /
//   Creativity 1-5) and Post Grading (decision and notes).
import { interpolate, useCurrentFrame } from "remotion";
import { Card, Pop } from "../../kit/Bits";
import { clamp, Exit, Sub, Title } from "../../kit/Explainer";
import { Stage } from "../../kit/Light";
import { Recommendation } from "../../kit/Recommendation";
import { C, DISPLAY, LIGHT } from "../../kit/theme";

const SLOTS = [
  { title: "Intros", minutes: 5 },
  { title: "Behaviorals", minutes: 30, rotation: true },
  { title: "Market Size", minutes: 15, rotation: true },
  { title: "Present", minutes: 2 },
  { title: "Questions", minutes: 8 },
];
const BAR_W = 1500;

export function TheHour() {
  const frame = useCurrentFrame();
  const end = 200;
  const grow = interpolate(frame, [30, 90], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  let at = 0;
  return (
    <Stage>
      <Title kicker="How the hour runs" text="One hour, three rotations" accent={[2, 3]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: (1920 - BAR_W) / 2, top: 360, width: BAR_W, fontFamily: DISPLAY }}>
          <div style={{ display: "flex", width: BAR_W * grow, overflow: "hidden", borderRadius: 18, height: 130 }}>
            {SLOTS.map((s) => {
              const w = (s.minutes / 60) * BAR_W;
              return (
                <div
                  key={s.title}
                  style={{
                    flex: `0 0 ${w}px`,
                    background: s.rotation ? C.blue : "#dbe4ef",
                    color: s.rotation ? "#fff" : C.navy,
                    borderRight: "4px solid #fff",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                    fontSize: w > 150 ? 30 : 18,
                    textAlign: "center",
                    lineHeight: 1.15,
                  }}
                >
                  {w > 60 && <div>{s.title}</div>}
                  <div style={{ fontSize: w > 150 ? 22 : 16, opacity: 0.8 }}>{s.minutes}m</div>
                </div>
              );
            })}
          </div>
          <div style={{ position: "relative", height: 40, marginTop: 10 }}>
            {SLOTS.map((s) => {
              const left = (at / 60) * BAR_W;
              at += s.minutes;
              return (
                <div key={s.title} style={{ position: "absolute", left, fontSize: 20, fontWeight: 700, color: LIGHT.muted, opacity: grow }}>
                  {at - s.minutes}
                </div>
              );
            })}
            <div style={{ position: "absolute", right: 0, fontSize: 20, fontWeight: 700, color: LIGHT.muted, opacity: grow }}>60</div>
          </div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 590, display: "flex", justifyContent: "center", gap: 40 }}>
          {[
            { head: "Behaviorals", body: "Notes per question, then three scores out of 5" },
            { head: "Market Sizing", body: "Notes on the case, then three scores out of 5" },
            { head: "Post Grading", body: "Your decision, and why" },
          ].map((r, i) => (
            <Pop key={r.head} at={100 + i * 12} y={60}>
              <Card style={{ width: 440, height: 170, padding: "26px 30px" }}>
                <div style={{ fontSize: 30, fontWeight: 800, color: C.blue }}>{r.head}</div>
                <div style={{ fontSize: 24, fontWeight: 600, color: LIGHT.muted, marginTop: 10, lineHeight: 1.3 }}>{r.body}</div>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub text="The page keeps time: Behaviorals and Market Size count down for you." accent={[3, 4]} at={150} exitAt={end} top={860} />
      </Exit>
    </Stage>
  );
}

export function After() {
  return (
    <Recommendation
      youBody="score each rotation and pick a decision"
      sub="Hit Save All before you leave, so nothing is left unsaved."
      subAccent={[1, 2]}
    />
  );
}
