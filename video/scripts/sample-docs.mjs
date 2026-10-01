// Makes the made-up documents the capture serves to the grading modal: a
// one-page resume PDF and a short applicant video. Written to assets/.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "assets");
mkdirSync(dir, { recursive: true });

const RESUME = `<!doctype html><html><head><style>
  @page { size: Letter; margin: 0.6in 0.7in; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 10.5pt; line-height: 1.32; }
  h1 { text-align: center; font-size: 20pt; letter-spacing: 0.06em; margin: 0 0 2px; font-weight: 700; }
  .contact { text-align: center; font-size: 9.5pt; margin-bottom: 10px; }
  h2 { font-size: 10.5pt; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid #111; margin: 12px 0 5px; padding-bottom: 1px; }
  .row { display: flex; justify-content: space-between; font-weight: 700; }
  .sub { display: flex; justify-content: space-between; font-style: italic; margin-bottom: 2px; }
  ul { margin: 2px 0 7px 16px; padding: 0; } li { margin: 1px 0; }
</style></head><body>
  <h1>TAYLOR KIM</h1>
  <div class="contact">Los Angeles, CA &nbsp;|&nbsp; (310) 555-0142 &nbsp;|&nbsp; taylor.kim@g.ucla.edu &nbsp;|&nbsp; linkedin.com/in/taylor-kim</div>
  <h2>Education</h2>
  <div class="row"><span>University of California, Los Angeles</span><span>Los Angeles, CA</span></div>
  <div class="sub"><span>B.A. Business Economics, Minor in Data Science Engineering &nbsp;·&nbsp; GPA 3.84</span><span>Expected June 2028</span></div>
  <ul><li>Coursework: Corporate Finance, Microeconomic Theory, Accounting Principles, Statistical Modeling</li></ul>
  <h2>Experience</h2>
  <div class="row"><span>Bruin Food Pantry</span><span>Los Angeles, CA</span></div>
  <div class="sub"><span>Operations Lead</span><span>Sep 2025 – Present</span></div>
  <ul>
    <li>Led a 5-person team to redesign inventory tracking, cutting restocking time from 3 days to 1</li>
    <li>Built a demand forecast in Google Sheets that reduced food waste by 22% over two quarters</li>
    <li>Recruited and trained 18 new volunteers; grew weekly shifts covered from 60% to 95%</li>
  </ul>
  <div class="row"><span>Westside Credit Union</span><span>Santa Monica, CA</span></div>
  <div class="sub"><span>Business Analyst Intern</span><span>Jun 2025 – Sep 2025</span></div>
  <ul>
    <li>Analyzed 40,000+ member transactions to size a new student checking product, presented to the VP of Growth</li>
    <li>Automated a weekly branch performance report in Python, saving the team ~6 hours per week</li>
    <li>Interviewed 25 members and synthesized findings into three onboarding recommendations, two adopted</li>
  </ul>
  <div class="row"><span>LA Youth Tutoring Collective</span><span>Los Angeles, CA</span></div>
  <div class="sub"><span>Math Tutor</span><span>Jan 2024 – Jun 2025</span></div>
  <ul>
    <li>Tutored 12 high school students weekly in algebra and statistics; average test scores rose 15%</li>
  </ul>
  <h2>Leadership &amp; Activities</h2>
  <div class="row"><span>Undergraduate Business Society</span><span>Los Angeles, CA</span></div>
  <div class="sub"><span>Case Competition Chair</span><span>Oct 2025 – Present</span></div>
  <ul>
    <li>Organized a 120-participant case competition with three corporate sponsors and $3,000 in prizes</li>
  </ul>
  <h2>Skills &amp; Interests</h2>
  <ul>
    <li><b>Technical:</b> Excel (financial modeling), Python (pandas), SQL, Tableau, Figma</li>
    <li><b>Languages:</b> English (native), Korean (fluent), Spanish (conversational)</li>
    <li><b>Interests:</b> Long-distance running, film photography, Korean home cooking</li>
  </ul>
</body></html>`;

// A stand-in for an applicant's intro video: a soft-lit room, a person-shaped
// silhouette and a lower-third, slowly pushing in.
const FRAME = `<!doctype html><html><body style="margin:0;width:1280px;height:720px;overflow:hidden;
  background: radial-gradient(ellipse at 30% 20%, #f6e7d2 0%, #d9c3a5 45%, #8f7a64 100%); font-family: Helvetica, Arial, sans-serif;">
  <div style="position:absolute;left:880px;top:90px;width:260px;height:330px;background:#5f6f5a;border-radius:8px;opacity:.55"></div>
  <div style="position:absolute;left:120px;top:60px;width:180px;height:240px;background:#efe3cf;border:10px solid #a88e6e;opacity:.8"></div>
  <div style="position:absolute;left:500px;top:150px;width:280px;height:280px;border-radius:50%;background:#3b2f2a"></div>
  <div style="position:absolute;left:530px;top:200px;width:220px;height:250px;border-radius:46% 46% 42% 42%;background:#c99b78"></div>
  <div style="position:absolute;left:380px;top:430px;width:520px;height:360px;border-radius:200px 200px 0 0;background:#0c74c1"></div>
  <div style="position:absolute;left:560px;top:430px;width:160px;height:70px;border-radius:0 0 80px 80px;background:#c99b78"></div>
  <div style="position:absolute;left:60px;bottom:56px;background:rgba(4,39,66,.82);color:#fff;padding:14px 24px;border-radius:8px;font-size:30px;font-weight:600">
    Hi! I'm Taylor &mdash; here's why UConsulting</div>
</body></html>`;

export async function makeSampleDocs(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(RESUME);
  await page.pdf({ path: join(dir, "resume.pdf"), format: "Letter", printBackground: true });
  await page.setContent(FRAME);
  await page.screenshot({ path: join(dir, "video-frame.png") });
  await page.close();
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-loop", "1", "-i", join(dir, "video-frame.png"),
    "-vf", "zoompan=z='1+0.0008*on':d=180:s=1280x720:fps=30,format=yuv420p",
    "-t", "6", "-c:v", "libx264", "-movflags", "+faststart", join(dir, "video.mp4"),
  ]);
  return { resume: join(dir, "resume.pdf"), video: join(dir, "video.mp4") };
}
