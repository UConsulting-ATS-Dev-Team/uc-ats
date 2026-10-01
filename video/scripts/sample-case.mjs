// A made-up four-page case deck for the final round tutorials, rendered to PNGs the
// way the ATS stores case pages: a prompt, two exhibits and an interviewer-only guide.
// Written to assets/case/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "assets", "case");

const css = `
  * { box-sizing: border-box; margin: 0; }
  body { width: 1600px; height: 900px; font-family: Georgia, serif; color: #1b2a3a; background: #fff; }
  .slide { width: 1600px; height: 900px; padding: 80px 110px; position: relative; }
  .bar { position: absolute; left: 0; top: 0; width: 100%; height: 18px; background: #0c3c66; }
  .tag { font: 600 22px Helvetica, Arial, sans-serif; letter-spacing: .14em; color: #0c74c1; text-transform: uppercase; }
  h1 { font-size: 64px; margin: 18px 0 30px; }
  p, li { font-size: 30px; line-height: 1.5; }
  ul { margin-left: 34px; }
  table { border-collapse: collapse; font: 28px Helvetica, Arial, sans-serif; margin-top: 30px; width: 100%; }
  th, td { border-bottom: 2px solid #d5dde6; padding: 16px 12px; text-align: left; }
  th { color: #0c3c66; }
  .bars { display: flex; align-items: flex-end; gap: 60px; height: 420px; margin-top: 40px; padding-left: 40px; border-left: 3px solid #1b2a3a; border-bottom: 3px solid #1b2a3a; }
  .b { width: 140px; background: #0c74c1; position: relative; }
  .b span { position: absolute; bottom: -50px; width: 100%; text-align: center; font: 24px Helvetica, Arial, sans-serif; }
  .b em { position: absolute; top: -40px; width: 100%; text-align: center; font: 600 24px Helvetica, Arial, sans-serif; font-style: normal; }
  .guide { background: #fff7e6; }
  .warn { font: 700 24px Helvetica, Arial, sans-serif; color: #b45309; }
`;

const PAGES = [
  {
    name: "p1",
    html: `<div class="slide"><div class="bar"></div>
      <div class="tag">Final round case</div>
      <h1>Westwood Coffee Co.</h1>
      <p>Westwood Coffee runs four cafés near campus. Revenue has been flat for two years while rent keeps rising.</p>
      <p style="margin-top:28px">The founder asks: <b>should Westwood open a fifth café, or add catering for campus events?</b></p>
      <p style="margin-top:28px">How would you approach this decision?</p></div>`,
  },
  {
    name: "p2",
    html: `<div class="slide"><div class="bar"></div>
      <div class="tag">Exhibit 1</div>
      <h1>Revenue per café, last year</h1>
      <div class="bars">
        <div class="b" style="height:340px"><em>$612k</em><span>Bruin Walk</span></div>
        <div class="b" style="height:250px"><em>$448k</em><span>Gayley</span></div>
        <div class="b" style="height:300px"><em>$540k</em><span>Le Conte</span></div>
        <div class="b" style="height:180px"><em>$322k</em><span>Sawtelle</span></div>
      </div></div>`,
  },
  {
    name: "p3",
    html: `<div class="slide"><div class="bar"></div>
      <div class="tag">Exhibit 2</div>
      <h1>Campus catering demand</h1>
      <table>
        <tr><th>Event type</th><th>Events / year</th><th>Avg. order</th></tr>
        <tr><td>Student org meetings</td><td>1,200</td><td>$180</td></tr>
        <tr><td>Department seminars</td><td>450</td><td>$420</td></tr>
        <tr><td>Recruiting info sessions</td><td>160</td><td>$900</td></tr>
      </table></div>`,
  },
  {
    name: "p4",
    html: `<div class="slide guide"><div class="bar"></div>
      <div class="tag">Interviewer guide</div>
      <h1>What a strong answer covers</h1>
      <ul>
        <li>Compares both options on revenue, cost and risk, not revenue alone</li>
        <li>Sizes catering from Exhibit 2: about $600k a year at full share</li>
        <li>Notices Sawtelle underperforms before proposing a fifth café</li>
        <li>Lands on a recommendation with next steps</li>
      </ul>
      <p class="warn" style="margin-top:36px">Not shown to the candidate.</p></div>`,
  },
];

/** Renders the deck; returns { [name]: path }. */
export async function makeSampleCase(browser) {
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const out = {};
  for (const p of PAGES) {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${p.html}</body></html>`);
    out[p.name] = join(dir, `${p.name}.png`);
    await page.screenshot({ path: out[p.name] });
  }
  await page.close();
  return out;
}
