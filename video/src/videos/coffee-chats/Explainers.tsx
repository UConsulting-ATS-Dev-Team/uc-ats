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
//
// Which groups are yours is not in the ATS: candidates wear nametags with their
// group, and you pick the groups the nametags at your table show.
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Card, Person, Pop } from "../../kit/Bits";
import { Exit, Sub, Title } from "../../kit/Explainer";
import { Recommendation } from "../../kit/Recommendation";
import { Stage } from "../../kit/Light";
import { C, LIGHT } from "../../kit/theme";

// ---------- 1. Sittings, groups and nametags ----------

const GROUPS = [
  { label: "1A", people: 3 },
  { label: "1B", people: 2 },
  { label: "1C", people: 2 },
];

/** Who sat down at your table: each nametag carries the person's group. */
const TABLE = ["1A", "1A", "1A", "1B", "1B"];
const atTable = (label: string) => TABLE.includes(label);

export function Sittings() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const end = 250;
  // Groups not at your table fade on the sitting; yours get ticked in the picker.
  const fade = spring({ frame: frame - 96, fps, config: { damping: 16, stiffness: 120 } });
  const tick = (i: number) => spring({ frame: frame - (124 + i * 20), fps, config: { damping: 16, stiffness: 120 } });
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
                  const mine = atTable(g.label);
                  return (
                    <Pop key={g.label} at={38 + i * 10} y={40}>
                      <div
                        style={{
                          width: 210,
                          height: 220,
                          borderRadius: 18,
                          border: `3px ${mine ? "solid" : "dashed"} ${mine ? C.blue : "#cbd5e1"}`,
                          background: mine ? "rgba(12,116,193,0.06)" : "transparent",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          paddingTop: 18,
                          opacity: mine ? 1 : 1 - 0.55 * fade,
                        }}
                      >
                        <div style={{ fontSize: 30, fontWeight: 800, color: mine ? C.blue : C.navy }}>Group {g.label}</div>
                        <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
                          {Array.from({ length: g.people }, (_, p) => (
                            <Person key={p} size={44} color={mine ? C.blue : C.navy} />
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
        {/* Your table: the nametags say which groups you have */}
        <div style={{ position: "absolute", left: 1150, top: 330 }}>
          <Pop at={58} y={80}>
            <Card style={{ width: 540, height: 430, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 24 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: LIGHT.muted }}>Your table's nametags</div>
              <div style={{ display: "flex", gap: 14, marginTop: 16 }}>
                {TABLE.map((g, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <Person size={56} color={C.navy} />
                    <Pop at={74 + i * 5} y={8}>
                      <div
                        style={{
                          marginTop: -30,
                          background: "#fff",
                          border: `2px solid ${C.blue}`,
                          borderRadius: 6,
                          fontSize: 18,
                          fontWeight: 800,
                          color: C.blue,
                          padding: "1px 7px",
                        }}
                      >
                        {g}
                      </div>
                    </Pop>
                  </div>
                ))}
              </div>
              {/* Start Interview's picker: tick the groups the nametags show */}
              <div style={{ width: 420, marginTop: 30, display: "flex", flexDirection: "column", gap: 10 }}>
                {GROUPS.map((g, i) => {
                  const on = atTable(g.label) ? tick(i) > 0.5 : false;
                  return (
                    <Pop key={g.label} at={100 + i * 6} y={20}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          padding: "8px 14px",
                          borderRadius: 10,
                          border: `2px solid ${on ? C.blue : "#e2e8f0"}`,
                          background: on ? "rgba(12,116,193,0.06)" : "#fff",
                          fontSize: 22,
                          fontWeight: 700,
                          color: atTable(g.label) ? C.navy : LIGHT.muted,
                        }}
                      >
                        <div
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 5,
                            border: `2px solid ${on ? C.blue : "#94a3b8"}`,
                            background: on ? C.blue : "#fff",
                            color: "#fff",
                            fontSize: 18,
                            lineHeight: "20px",
                            textAlign: "center",
                          }}
                        >
                          {on ? "✓" : ""}
                        </div>
                        Afternoon Session · {g.label}
                      </div>
                    </Pop>
                  );
                })}
              </div>
            </Card>
          </Pop>
        </div>
        <Sub
          text="Read the nametags at your table, then pick those groups: here 1A and 1B."
          accent={[2, 9, 11, 13]}
          at={160}
          exitAt={end}
          top={830}
        />
      </Exit>
    </Stage>
  );
}

// ---------- 2. After the chat ----------

export function After() {
  return (
    <Recommendation
      youBody="pick a decision for each candidate"
      sub="Changed your mind? Edit it from My Evaluations."
      subAccent={[6, 7]}
    />
  );
}
