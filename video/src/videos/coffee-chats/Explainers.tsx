// The explainer beats around the coffee chat walkthrough.
//
// Every rule stated here comes from the code:
// - Members claim coffee chat sittings themselves on Interview RSVP
//   (InterviewStaffingSignup.jsx); first round is staffed by recruitment.
// - A coffee chat sitting is a container: its candidates are split into
//   rotation groups (1A, 1B, ...) and those are what an interviewer picks,
//   up to three at a time (getRosterForInterview in
//   server/src/services/interviewRoster.js, handleGroupToggle in
//   AssignedInterviews.jsx).
// - Each candidate gets notes and one of four decisions
//   (MemberInterviewInterface.jsx, utils/decisionOptions.js).
// - The decision is a recommendation; advancing and rejecting happen in
//   Staging (DEFAULT_GUIDE in server/src/services/decisionGuides.js).
// - It can be changed afterwards from My Evaluations (Edit Evaluation in
//   AssignedInterviews.jsx).
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Card, Person, Pop } from "../../kit/Bits";
import { clamp, Exit, Sub, Title } from "../../kit/Explainer";
import { Stage } from "../../kit/Light";
import { C, LIGHT } from "../../kit/theme";

// ---------- 1. Sittings and groups ----------

const GROUPS = [
  { label: "1A", people: 3 },
  { label: "1B", people: 2 },
  { label: "1C", people: 2 },
];

export function Sittings() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const end = 200;
  // The groups come to your table one after another.
  const turn = (i: number) => spring({ frame: frame - (96 + i * 22), fps, config: { damping: 16, stiffness: 120 } });
  return (
    <Stage>
      <Title kicker="How coffee chats work" text="You run a sitting. Candidates come in groups." accent={[3, 7]} exitAt={end} />
      <Exit at={end}>
        {/* The sitting */}
        <div style={{ position: "absolute", left: 230, top: 330 }}>
          <Pop at={20} y={80}>
            <Card style={{ width: 760, height: 430, padding: "30px 36px" }}>
              <div style={{ fontSize: 34, fontWeight: 800 }}>Afternoon Session</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: LIGHT.muted, marginTop: 4 }}>7 candidates booked</div>
              <div style={{ display: "flex", gap: 22, marginTop: 34 }}>
                {GROUPS.map((g, i) => {
                  const away = turn(i);
                  return (
                    <Pop key={g.label} at={38 + i * 10} y={40}>
                      <div
                        style={{
                          width: 210,
                          height: 220,
                          borderRadius: 18,
                          border: `3px ${i === 0 ? "solid" : "dashed"} ${i === 0 ? C.blue : "#cbd5e1"}`,
                          background: i === 0 ? "rgba(12,116,193,0.06)" : "transparent",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          paddingTop: 18,
                          opacity: 1 - 0.55 * away,
                        }}
                      >
                        <div style={{ fontSize: 30, fontWeight: 800, color: i === 0 ? C.blue : C.navy }}>Group {g.label}</div>
                        <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
                          {Array.from({ length: g.people }, (_, p) => (
                            <Person key={p} size={44} color={i === 0 ? C.blue : C.navy} />
                          ))}
                        </div>
                      </div>
                    </Pop>
                  );
                })}
              </div>
            </Card>
          </Pop>
        </div>
        {/* Your table */}
        <div style={{ position: "absolute", left: 1150, top: 330 }}>
          <Pop at={58} y={80}>
            <Card style={{ width: 540, height: 430, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 34 }}>
              <div style={{ position: "relative" }}>
                <Person size={84} color={C.navy} />
                <Pop at={70} y={10} style={{ position: "absolute", left: -2, top: -42, width: 88, textAlign: "center" }}>
                  <span style={{ background: C.blue, color: "#fff", fontSize: 20, fontWeight: 800, borderRadius: 8, padding: "3px 12px" }}>You</span>
                </Pop>
              </div>
              <div style={{ width: 380, height: 22, borderRadius: 11, background: "#e5e9ef", marginTop: 18 }} />
              <div style={{ fontSize: 24, fontWeight: 700, color: LIGHT.muted, marginTop: 30 }}>Up to three groups at a time</div>
              <div style={{ display: "flex", gap: 14, marginTop: 26 }}>
                {GROUPS.map((g, i) => {
                  const p = turn(i);
                  return (
                    <div
                      key={g.label}
                      style={{
                        fontSize: 26,
                        fontWeight: 800,
                        padding: "8px 20px",
                        borderRadius: 999,
                        color: "#fff",
                        background: C.blue,
                        opacity: p,
                        transform: `translateX(${(1 - p) * -260}px) scale(${0.7 + 0.3 * p})`,
                      }}
                    >
                      {g.label}
                    </div>
                  );
                })}
              </div>
            </Card>
          </Pop>
        </div>
        <Sub
          text="Every candidate in your groups gets their own notes and their own decision."
          accent={[6, 7, 11, 12]}
          at={150}
          exitAt={end}
          top={830}
        />
      </Exit>
    </Stage>
  );
}

// ---------- 2. After the chat ----------

const DECISION_CHIPS = [
  { label: "Yes", color: "#15803d", bg: "#dcfce7" },
  { label: "Maybe-Yes", color: "#166534", bg: "#ecfdf5" },
  { label: "Maybe-No", color: "#c2410c", bg: "#ffedd5" },
  { label: "No", color: "#b91c1c", bg: "#fee2e2" },
];

const STEPS = [
  { head: "You", body: "pick a decision for each candidate", at: 26 },
  { head: "It's a recommendation", body: "stored against the candidate", at: 62 },
  { head: "Staging", body: "is where admins advance or reject", at: 98 },
];

export function After() {
  const frame = useCurrentFrame();
  const end = 185;
  const flow = (i: number) => interpolate(frame, [STEPS[i].at + 18, STEPS[i].at + 34], [0, 1], clamp);
  return (
    <Stage>
      <Title kicker="What happens next" text="Your decision is a recommendation" accent={[4]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 360, display: "flex", justifyContent: "center", alignItems: "center", gap: 30 }}>
          {STEPS.map((s, i) => (
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
              {i < STEPS.length - 1 && (
                <div style={{ width: 60, height: 6, borderRadius: 3, background: C.blue, opacity: flow(i), transform: `scaleX(${flow(i)})`, transformOrigin: "0 50%" }} />
              )}
            </div>
          ))}
        </div>
        <Sub text="Changed your mind? Edit it any time from My Evaluations." accent={[6, 7]} at={132} exitAt={end} top={790} />
      </Exit>
    </Stage>
  );
}
