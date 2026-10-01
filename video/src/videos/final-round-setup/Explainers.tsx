// The explainer before the final round setup walkthrough.
//
// Every rule stated here comes from the code:
// - Cases are uploaded and assigned to candidates by admins only (Cases.jsx is
//   AccessControl ADMIN; POST /api/cases/assignments is requireAdmin).
// - A member can open a case only a set number of hours before the interview they run
//   it in; admins are never restricted; the default is 2 hours
//   (server/src/services/caseVisibility.js, DEFAULT_LEAD_TIME_HOURS).
// - Interviewers configure the shared behavioral questions when they start the
//   interview, and the final round page shows each candidate's Round One history
//   (AssignedInterviews.jsx, RoundOneHistoryPanel.jsx).
import { Card, Pop } from "../../kit/Bits";
import { Exit, Sub, Title } from "../../kit/Explainer";
import { Stage } from "../../kit/Light";
import { C } from "../../kit/theme";

const COLUMNS = [
  {
    who: "Admins",
    items: ["Upload the case deck", "Give every candidate a case", "Set how early it opens: 2 hours by default"],
    at: 24,
  },
  {
    who: "Interviewers",
    items: ["Write the questions everyone gets", "Read each candidate's Round One history", "Open the case once it unlocks"],
    at: 64,
  },
];

export function WhoDoesWhat() {
  const end = 215;
  return (
    <Stage>
      <Title kicker="Before the room" text="Two people set up a final round" accent={[0, 1]} exitAt={end} />
      <Exit at={end}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 310, display: "flex", justifyContent: "center", gap: 70 }}>
          {COLUMNS.map((col) => (
            <Pop key={col.who} at={col.at} y={80}>
              <Card style={{ width: 640, height: 470, padding: "40px 46px" }}>
                <div style={{ fontSize: 42, fontWeight: 800, color: C.blue }}>{col.who}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 26, marginTop: 34 }}>
                  {col.items.map((item, i) => (
                    <Pop key={item} at={col.at + 14 + i * 8} y={16}>
                      <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
                        <span style={{ fontSize: 30, fontWeight: 800, color: C.blue, width: 30 }}>{i + 1}</span>
                        <span style={{ fontSize: 30, fontWeight: 600, color: C.navy, lineHeight: 1.3 }}>{item}</span>
                      </div>
                    </Pop>
                  ))}
                </div>
              </Card>
            </Pop>
          ))}
        </div>
        <Sub text="Cases stay locked until then, so they cannot leak to candidates. Admins can always open them." accent={[2, 3]} at={140} exitAt={end} top={840} />
      </Exit>
    </Stage>
  );
}
