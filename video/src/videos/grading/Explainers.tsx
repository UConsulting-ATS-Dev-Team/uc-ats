// The explainer beats between and after the walkthrough, drawn the way
// Coffee Chats 101 draws: flat people, light cards, blue for what matters.
//
// Every rule stated here comes from the code:
// - Documents and maxima: DEFAULT_RUBRICS / AGGREGATION in
//   server/src/services/documentRubrics.js (resume sums to 13, short answer
//   averages to 3, video 0-2; participation adds up to PARTICIPATION_MAX = 3).
// - Every member grades every document of every applicant on their team:
//   GET /review-teams/member-applications and checkTeamCompletion in
//   server/src/routes/reviewTeams.js; one score row per grader per candidate.
// - Graders' scores are averaged per document, the three are added, plus
//   participation: server/src/services/stagingSnapshot.js. Staging ranks by
//   that total; no candidate-facing page or email reads a score.
// Per-team deliberations are how UConsulting runs the cycle, not code.
//
// The maxima here (13, 3, 2, 21) are the shipped defaults. Admins can change rubric
// ranges (Admin Document Grading -> Edit rubrics); if they do, re-render this video.
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Card, Count, Icon, ICONS, Person, Pop } from "../../kit/Bits";
import { clamp, Exit, Sub, Title } from "../../kit/Explainer";
import { Headline, Kicker, Stage } from "../../kit/Light";
import { C, DISPLAY, LIGHT } from "../../kit/theme";

// ---------- 1. What gets graded ----------

// Only the resume is required. A missing short answer or video shows as
// "No Document" with its button disabled (DocumentGrading.jsx).
const DOCS = [
  { icon: ICONS.resume, name: "Resume", max: "13", required: true },
  { icon: ICONS.short, name: "Short Answer", max: "3", required: false },
  { icon: ICONS.video, name: "Video", max: "2", required: false },
];

export function Documents() {
  const frame = useCurrentFrame();
  const end = 155;
  return (
    <Stage>
      <Title kicker="What you're grading" text="Every applicant sends a resume" accent={[4]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 420, display: "flex", justifyContent: "center", gap: 56 }}>
          {DOCS.map((d, i) => (
            <Pop key={d.name} at={30 + i * 15} y={120}>
              <Card
                style={{
                  width: 400,
                  height: 420,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 22,
                  transform: `rotate(${(i - 1) * 2.5 * interpolate(frame, [30 + i * 15, 60 + i * 15], [1, 0], clamp)}deg)`,
                }}
              >
                <div style={{ width: 120, height: 120, borderRadius: 30, background: "rgba(12,116,193,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon d={d.icon} size={70} color={C.navy} />
                </div>
                <div style={{ fontSize: 42, fontWeight: 800 }}>{d.name}</div>
                <div style={{ fontSize: 28, fontWeight: 600, color: LIGHT.muted }}>
                  Scored out of <span style={{ color: C.blue, fontWeight: 800 }}>{d.max}</span>
                </div>
                <Pop at={48 + i * 15} y={10}>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 800,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      padding: "6px 16px",
                      borderRadius: 999,
                      color: d.required ? "#fff" : C.navy,
                      background: d.required ? C.blue : "transparent",
                      border: `2px solid ${d.required ? C.blue : "#cbd5e1"}`,
                    }}
                  >
                    {d.required ? "Required" : "Optional"}
                  </div>
                </Pop>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub
          text="Short answers and videos are optional. If one is missing, its row says No Document and there's nothing to grade."
          accent={[0, 1, 2, 3, 4, 5]}
          at={84}
          exitAt={end}
          top={880}
        />
      </Exit>
    </Stage>
  );
}

// ---------- 2. Review teams ----------

const TEAMS = ["Review Team 3", "Review Team 4", "Review Team 5"];
const TEAM_X = [480, 960, 1440];

export function Teams() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const end = 170;
  const focus = interpolate(frame, [100, 112], [0, 1], clamp);
  // Nine applicants dealt round-robin, as auto-distribute does.
  const deal = Array.from({ length: 9 }, (_, i) => ({ team: i % 3, slot: Math.floor(i / 3), at: 44 + i * 5 }));
  return (
    <Stage>
      <Title kicker="Review teams" text="You grade as part of a review team" accent={[6, 7]} exitAt={end} />
      <Exit at={end}>
        {TEAMS.map((name, t) => {
          const dim = t === 1 ? 1 : 1 - 0.65 * focus;
          return (
            <div key={name} style={{ position: "absolute", left: TEAM_X[t] - 200, top: 330, width: 400, opacity: dim }}>
              <Pop at={18 + t * 6}>
                <Card style={{ height: 470, padding: "28px 0", display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ fontSize: 30, fontWeight: 800 }}>{name}</div>
                  <div style={{ display: "flex", gap: 22, marginTop: 50 }}>
                    {[0, 1, 2].map((m) => (
                      <div key={m} style={{ position: "relative" }}>
                        <Person size={62} color={C.navy} />
                        {t === 1 && m === 1 && (
                          <Pop at={30} y={10} style={{ position: "absolute", left: -6, top: -36, width: 74, textAlign: "center" }}>
                            <span style={{ background: C.blue, color: "#fff", fontSize: 18, fontWeight: 800, borderRadius: 8, padding: "3px 10px" }}>You</span>
                          </Pop>
                        )}
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: LIGHT.muted, marginTop: 10, letterSpacing: "0.06em" }}>MEMBERS</div>
                  <div style={{ width: 320, height: 2, background: "#e5e9ef", margin: "26px 0" }} />
                  <div style={{ height: 150 }} />
                  <div style={{ fontSize: 20, fontWeight: 600, color: LIGHT.muted, letterSpacing: "0.06em" }}>APPLICANTS</div>
                </Card>
              </Pop>
            </div>
          );
        })}
        {/* Applicants fly from a queue at the bottom into their team. */}
        {deal.map((d, i) => {
          const p = spring({ frame: frame - d.at, fps, config: { damping: 15, stiffness: 140 } });
          const tx = TEAM_X[d.team] - 108 + d.slot * 82;
          const ty = 660;
          const sx = 960 - 30;
          const sy = 1120;
          const dim = d.team === 1 ? 1 : 1 - 0.65 * focus;
          return (
            <div key={i} style={{ position: "absolute", left: sx + (tx - sx) * p, top: sy + (ty - sy) * p - Math.sin(p * Math.PI) * 120, opacity: dim }}>
              <Person size={60} color={C.blue} />
            </div>
          );
        })}
        {/* Every member to every applicant on the team. */}
        <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
          {[0, 1, 2].flatMap((m) =>
            [0, 1, 2].map((a) => {
              const x1 = TEAM_X[1] - 104 + m * 84 + 31;
              const y1 = 568;
              const x2 = TEAM_X[1] - 108 + a * 82 + 30;
              const y2 = 662;
              const draw = interpolate(frame, [112 + (m * 3 + a) * 2, 126 + (m * 3 + a) * 2], [0, 1], clamp);
              return (
                <line key={`${m}${a}`} x1={x1} y1={y1} x2={x1 + (x2 - x1) * draw} y2={y1 + (y2 - y1) * draw} stroke={C.blue} strokeWidth={3} strokeLinecap="round" opacity={0.55 * draw} />
              );
            }),
          )}
        </svg>
        <Sub
          text="Everyone on your team grades every document from every applicant your team is given."
          accent={[0, 1, 2, 3, 4, 5]}
          at={110}
          exitAt={end}
          top={846}
        />
      </Exit>
    </Stage>
  );
}

// ---------- 3. How it adds up ----------

type Term = { label: string; note: string; scores: number[]; avg: number; max: string; at: number };
const TERMS: Term[] = [
  { label: "Resume", note: "team average", scores: [11, 10, 12], avg: 11, max: "13", at: 40 },
  { label: "Short Answer", note: "team average", scores: [3, 2.33, 2.67], avg: 2.67, max: "3", at: 74 },
  { label: "Video", note: "team average", scores: [2, 1, 2], avg: 1.67, max: "2", at: 108 },
];

function TermCard({ t }: { t: Term }) {
  const frame = useCurrentFrame();
  const merge = interpolate(frame, [t.at + 16, t.at + 30], [0, 1], { ...clamp, easing: (x) => x * x * (3 - 2 * x) });
  return (
    <Pop at={t.at} y={80}>
      <Card style={{ width: 300, height: 330, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 30, position: "relative" }}>
        <div style={{ fontSize: 30, fontWeight: 800 }}>{t.label}</div>
        <div style={{ position: "relative", width: 260, height: 70, marginTop: 22 }}>
          {t.scores.map((s, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 130 - 38 + (i - 1) * 84 * (1 - merge),
                top: 10,
                width: 76,
                height: 44,
                borderRadius: 10,
                background: "#eef3f9",
                fontSize: 24,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: 1 - merge,
                transform: `scale(${1 - 0.3 * merge})`,
              }}
            >
              {s}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 84, fontWeight: 800, color: C.blue, lineHeight: 1, opacity: merge, transform: `scale(${0.6 + 0.4 * merge})`, marginTop: -40 }}>
          {t.avg}
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color: LIGHT.muted, marginTop: 10 }}>out of {t.max}</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: LIGHT.muted, marginTop: 14, letterSpacing: "0.06em", textTransform: "uppercase" }}>{t.note}</div>
      </Card>
    </Pop>
  );
}

function Op({ ch, at }: { ch: string; at: number }) {
  return (
    <Pop at={at} y={20} style={{ fontFamily: DISPLAY, fontSize: 64, fontWeight: 800, color: LIGHT.muted, width: 40, textAlign: "center" }}>
      {ch}
    </Pop>
  );
}

export function AddsUp() {
  const frame = useCurrentFrame();
  const end = 245;
  const total = 11 + 8 / 3 + 5 / 3 + 2;
  const glow = interpolate(frame, [176, 186, 210], [0, 1, 0.4], clamp);
  return (
    <Stage>
      <Title kicker="How scores add up" text="Your team's scores become one number" accent={[4, 5]} exitAt={end} top={90} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 330, display: "flex", justifyContent: "center", alignItems: "center", gap: 14 }}>
          <TermCard t={TERMS[0]} />
          <Op ch="+" at={68} />
          <TermCard t={TERMS[1]} />
          <Op ch="+" at={102} />
          <TermCard t={TERMS[2]} />
          <Op ch="+" at={136} />
          <Pop at={140} y={80}>
            <Card style={{ width: 230, height: 330, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 30 }}>
              <div style={{ fontSize: 30, fontWeight: 800, textAlign: "center", lineHeight: 1.1 }}>Events &amp; GTKUC</div>
              <div style={{ fontSize: 84, fontWeight: 800, color: C.blue, lineHeight: 1, marginTop: 38 }}>2</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: LIGHT.muted, marginTop: 10 }}>up to 3</div>
            </Card>
          </Pop>
          <Op ch="=" at={168} />
          <Pop at={172} y={80} from={0.6}>
            <Card
              style={{
                width: 290,
                height: 330,
                background: C.navy,
                color: "#fff",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: `0 0 ${60 * glow}px rgba(12,116,193,${0.7 * glow}), 0 30px 60px -24px rgba(4,39,66,0.6)`,
              }}
            >
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "0.08em", opacity: 0.75 }}>TOTAL</div>
              <div style={{ fontSize: 96, fontWeight: 800, lineHeight: 1.05 }}>
                <Count to={total} start={174} duration={26} />
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: C.blueLight }}>out of 21</div>
            </Card>
          </Pop>
        </div>
        <Sub
          text="Staging ranks every applicant by that total. Applicants never see their scores."
          accent={[0, 1, 2, 3]}
          at={196}
          exitAt={end}
          top={760}
        />
      </Exit>
    </Stage>
  );
}

// ---------- 4. Deliberations ----------

const DELIB = [
  { team: "Review Team 3", scores: [10, 11, 9] },
  { team: "Review Team 4", scores: [11, 10, 4], outlier: 2 },
  { team: "Review Team 5", scores: [7, 8, 8] },
];

export function Delibs() {
  const frame = useCurrentFrame();
  const end = 155;
  const SCALE_W = 440;
  const x = (s: number) => ((s - 1) / 12) * SCALE_W;
  const hot = interpolate(frame, [86, 96], [0, 1], clamp);
  return (
    <Stage>
      <Title kicker="Then: deliberations" text="Each review team meets on its own" accent={[4, 5, 6]} exitAt={end} top={100} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 360, display: "flex", justifyContent: "center", gap: 44 }}>
          {DELIB.map((d, t) => (
            <Pop key={d.team} at={22 + t * 10} y={80}>
              <Card style={{ width: 520, height: 320, padding: "30px 40px", boxSizing: "border-box", opacity: t === 1 ? 1 : 1 - 0.5 * hot }}>
                <div style={{ fontSize: 28, fontWeight: 800 }}>{d.team}</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: LIGHT.muted, marginTop: 6 }}>Student 905… · Resume</div>
                <div style={{ position: "relative", height: 120, marginTop: 40 }}>
                  <div style={{ position: "absolute", left: 0, right: 0, top: 30, height: 6, borderRadius: 3, background: "#e5e9ef" }} />
                  {[1, 13].map((n) => (
                    <div key={n} style={{ position: "absolute", left: x(n) - 20, top: 52, width: 40, textAlign: "center", fontSize: 20, fontWeight: 600, color: LIGHT.muted }}>
                      {n}
                    </div>
                  ))}
                  {d.scores.map((s, i) => {
                    const isOut = d.outlier === i;
                    const pulse = isOut ? 1 + 0.18 * hot * Math.abs(Math.sin((frame - 86) / 6)) : 1;
                    return (
                      <Pop key={i} at={40 + t * 10 + i * 5} y={-30} style={{ position: "absolute", left: x(s) - 20, top: 13 }}>
                        <div
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: "50%",
                            background: isOut ? `rgb(${4 + 181 * hot},${39 - 11 * hot},${66 - 38 * hot})` : C.navy,
                            border: "4px solid #fff",
                            boxShadow: isOut ? `0 0 0 ${10 * hot}px rgba(185,28,28,0.18)` : "0 2px 6px rgba(0,0,0,0.2)",
                            transform: `scale(${pulse})`,
                          }}
                        />
                      </Pop>
                    );
                  })}
                  {d.outlier !== undefined && (
                    <div
                      style={{
                        position: "absolute",
                        left: x(d.scores[d.outlier]) - 70,
                        top: -46,
                        width: 140,
                        textAlign: "center",
                        fontSize: 22,
                        fontWeight: 800,
                        color: "#b91c1c",
                        opacity: hot,
                        transform: `translateY(${(1 - hot) * 10}px)`,
                      }}
                    >
                      Outlier?
                    </div>
                  )}
                </div>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub text="A score way off from your team's gets called out and talked through, together." accent={[0, 1, 2, 3, 4]} at={98} exitAt={end} top={760} />
      </Exit>
    </Stage>
  );
}
