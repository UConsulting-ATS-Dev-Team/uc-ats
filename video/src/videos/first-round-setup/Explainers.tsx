// The explainer before the first round setup walkthrough.
//
// Every rule stated here comes from the code:
// - Shared ("behavioral") questions are asked of every candidate in the selected
//   groups, and are saved when Configure Questions is clicked (AssignedInterviews.jsx,
//   saveBehavioralQuestionsConfiguration).
// - Questions for a specific candidate show only on that candidate's row and save as
//   soon as they are added (CandidateQuestionSetup.jsx; first round only, see
//   server/src/services/candidateQuestions.js).
import { Card, Icon, ICONS, Person, Pop } from "../../kit/Bits";
import { Exit, Sub, Title } from "../../kit/Explainer";
import { Stage } from "../../kit/Light";
import { C, LIGHT } from "../../kit/theme";

const KINDS = [
  {
    head: "Shared questions",
    body: "Asked of everyone in the room",
    when: "Saved when you hit Configure Questions",
    at: 30,
    people: [true, true, true],
  },
  {
    head: "For one candidate",
    body: "Only on that candidate's row, written from their resume",
    when: "Saved as soon as you add it",
    at: 70,
    people: [true, false, false],
  },
];

export function TwoKinds() {
  const end = 215;
  return (
    <Stage>
      <Title kicker="Before the room" text="Two kinds of questions" accent={[0, 1]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 320, display: "flex", justifyContent: "center", gap: 70 }}>
          {KINDS.map((k, i) => (
            <Pop key={k.head} at={k.at} y={80}>
              <Card style={{ width: 620, height: 470, padding: "40px 46px", display: "flex", flexDirection: "column", gap: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                  <div style={{ width: 76, height: 76, borderRadius: 20, background: "rgba(12,116,193,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon d={i === 0 ? ICONS.short : ICONS.resume} size={46} color={C.navy} />
                  </div>
                  <div style={{ fontSize: 40, fontWeight: 800 }}>{k.head}</div>
                </div>
                <div style={{ fontSize: 30, fontWeight: 600, color: LIGHT.muted, lineHeight: 1.3 }}>{k.body}</div>
                <div style={{ display: "flex", gap: 22, marginTop: 10 }}>
                  {k.people.map((asked, p) => (
                    <Pop key={p} at={k.at + 16 + p * 6} y={20}>
                      <div style={{ position: "relative" }}>
                        <Person size={70} color={asked ? C.blue : "#cbd5e1"} />
                        {asked && (
                          <div style={{ position: "absolute", top: -18, right: -14, width: 34, height: 34, borderRadius: 17, background: C.navy, color: "#fff", fontSize: 22, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            ?
                          </div>
                        )}
                      </div>
                    </Pop>
                  ))}
                </div>
                <div style={{ marginTop: "auto", fontSize: 24, fontWeight: 700, color: C.blue }}>{k.when}</div>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub text="Both show up on the first round page, next to that candidate's notes." accent={[0, 1, 2]} at={140} exitAt={end} top={850} />
      </Exit>
    </Stage>
  );
}
