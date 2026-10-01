// The explainer beats around the final round walkthrough.
//
// Every rule stated here comes from the code (FinalRoundInterviewInterface.jsx):
// - The page has three tabs: Behavioral Assessment (notes per question), Case
//   Interview (the case viewer and a five-part casing rubric: questions and prompt,
//   framework, quantitative, qualitative, conclusion) and Confirm Candidate Details (a
//   checklist of commitments).
// - The decision is asked when Save All finishes, for each candidate still without
//   one (FinalDecisionDialog.jsx); My Evaluations can still change it later.
import { Card, Pop } from "../../kit/Bits";
import { Exit, Sub, Title } from "../../kit/Explainer";
import { Stage } from "../../kit/Light";
import { Recommendation } from "../../kit/Recommendation";
import { C, LIGHT } from "../../kit/theme";

const TABS = [
  { head: "Behavioral Assessment", body: "Your notes on each question" },
  { head: "Case Interview", body: "The case deck beside a five-part rubric" },
  { head: "Confirm Candidate Details", body: "A checklist you go through together" },
];

export function ThreeTabs() {
  const end = 200;
  return (
    <Stage>
      <Title kicker="How the page works" text="One candidate, three tabs" accent={[2, 3]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 360, display: "flex", justifyContent: "center", gap: 40 }}>
          {TABS.map((t, i) => (
            <Pop key={t.head} at={26 + i * 14} y={70}>
              <Card style={{ width: 480, height: 280, padding: "36px 40px", display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: LIGHT.muted }}>{`Tab ${i + 1}`}</div>
                <div style={{ fontSize: 36, fontWeight: 800, color: C.blue, lineHeight: 1.15 }}>{t.head}</div>
                <div style={{ fontSize: 26, fontWeight: 600, color: C.navy, lineHeight: 1.3 }}>{t.body}</div>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub text="Your decision comes last, when you hit Save All." accent={[6, 7]} at={120} exitAt={end} top={760} />
      </Exit>
    </Stage>
  );
}

export function After() {
  return (
    <Recommendation
      youBody="pick a decision for each candidate"
      sub="Your notes and checklist stay with it. Staging decides who joins."
      subAccent={[7]}
    />
  );
}
