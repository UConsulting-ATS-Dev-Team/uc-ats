#!/usr/bin/env node
/**
 * Composes the tutorial's soundtrack from scratch: an original, license-free
 * coastal house track synthesized sample by sample, encoded to
 * public/music-<id>.mp3 with ffmpeg.
 *
 * Sunny and laid back rather than pumping: major-seventh chords, marimba
 * plucks with a ping-pong echo, a round kick, rim clicks, a swung shaker,
 * congas, a soft flute lead and a warm bass. 120 BPM, so a beat is 0.5s
 * (15 video frames) and a bar is 2s.
 *
 * Timing comes from the video's own timeline (src/videos/<id>/timeline.ts): the drop
 * lands as the intro ends, every scene and step start gets a soft hit, the
 * drums step out under the breakdowns, and every cursor click, keystroke and
 * save gets its own sound. The plan is written to public/music-cues-<id>.json.
 *
 * Usage: node scripts/make-music.mjs <id>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const id = process.argv[2];
if (!id) {
  console.error("Usage: npm run music -- <id>");
  process.exit(1);
}
const { SCENES, WALKS, music } = await import(`../src/videos/${id}/timeline.ts`);
const { FPS, sceneClock } = await import("../src/kit/timeline.ts");
const states = JSON.parse(readFileSync(join(root, `public/shots/${id}/states.json`), "utf8")).states;
const clock = sceneClock(SCENES);
const TOTAL_FRAMES = clock.total;
const walks = Object.fromEntries(Object.entries(WALKS).map(([k, build]) => [k, build(states)]));
const { slams, breaks } = music(walks);
const sec = (f) => f / FPS;
// Everything a walkthrough does, shifted onto the video's own clock.
const fromWalks = (pick) =>
  Object.entries(walks).flatMap(([name, w]) => pick(w).map((f) => clock.start(name) + f));
const first = SCENES[1].name;
const last = SCENES[SCENES.length - 1].name;
const plan = {
  duration: sec(TOTAL_FRAMES),
  // Intro hits: the logo, then the title words.
  slams: slams.map(sec),
  drop: sec(clock.start(first)),
  // A soft hit on every scene and every walkthrough step.
  cues: [
    ...SCENES.map((s) => clock.start(s.name)).filter((f) => f > clock.start(first) && f < clock.start(last)),
    ...fromWalks((w) => w.heads.map((h) => h.f0).filter((f) => f !== 0)),
  ]
    .sort((a, b) => a - b)
    .map(sec),
  breaks: breaks.map(([a, b]) => [sec(a), sec(b)]),
  outro: sec(TOTAL_FRAMES) - 2,
  clicks: fromWalks((w) => w.clicks).map(sec),
  keys: fromWalks((w) => w.keys).map(sec),
  chimes: fromWalks((w) => w.chimes).map(sec),
  sparkle: fromWalks((w) => (w.confetti === null ? [] : [w.confetti])).map(sec),
};
writeFileSync(join(root, `public/music-cues-${id}.json`), JSON.stringify(plan, null, 1));

const SR = 44100;
const BEAT = 0.5;
const BAR = BEAT * 4;
const S16 = BEAT / 4;
const SWING = S16 * 0.16; // every second sixteenth lands a touch late
const DUR = plan.duration;
const N = Math.ceil((DUR + 3) * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);
// The marimba gets its own bus so only it feeds the ping-pong echo.
const PL = new Float32Array(N);
const PR = new Float32Array(N);

let seed = 0x5eed1e;
const noise = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 0xffffffff) * 2 - 1;
};
const add = (buf, i, v) => {
  if (i >= 0 && i < N) buf[i] += v;
};
const panL = (pan) => Math.cos(((pan + 1) * Math.PI) / 4);
const panR = (pan) => Math.sin(((pan + 1) * Math.PI) / 4);
const addStereo = (i, v, pan = 0) => {
  add(L, i, v * panL(pan));
  add(R, i, v * panR(pan));
};
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// ---------- structure ----------
// F major, drifting down: Fmaj7 – Em7 – Dm7 – Cmaj7, one chord per bar.
const CHORDS = [
  [53, 57, 60, 64], // Fmaj7
  [52, 55, 59, 62], // Em7
  [50, 53, 57, 60], // Dm7
  [48, 52, 55, 59], // Cmaj7
];
const ROOTS = [41, 40, 38, 36]; // F2 E2 D2 C2
const chordAt = (t) => ((Math.floor(t / BAR) % 4) + 4) % 4;

const BREAKS = plan.breaks;
const inBreak = (t) => BREAKS.some(([a, b]) => t >= a && t < b);
const grooveOn = (t) => t >= plan.drop && t < plan.outro && !inBreak(t);

// A gentle sidechain: enough to breathe with the kick, not to pump.
const duck = (t) => {
  if (!grooveOn(t)) return 1;
  const since = ((t % BEAT) + BEAT) % BEAT;
  return 0.6 + 0.4 * Math.min(1, since / 0.2) ** 1.4;
};

// ---------- drums ----------
/** A round, soft kick: more thump than click. */
function kick(t0, gain = 1) {
  const len = 0.38 * SR;
  let phase = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    phase += (2 * Math.PI * (48 + 85 * Math.exp(-s * 30))) / SR;
    const body = Math.sin(phase) * Math.exp(-s * 8);
    addStereo(Math.floor(t0 * SR) + k, Math.tanh(body * 1.3) * 0.8 * gain);
  }
}

/** A wooden rim click with a little snap of noise. */
function rim(t0, gain = 1) {
  const len = 0.09 * SR;
  let prev = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const n = noise();
    const hp = n - prev;
    prev = n;
    const tone = Math.sin(2 * Math.PI * 1650 * s) * Math.exp(-s * 70) + Math.sin(2 * Math.PI * 520 * s) * Math.exp(-s * 55) * 0.6;
    addStereo(Math.floor(t0 * SR) + k, (tone * 0.5 + hp * Math.exp(-s * 45) * 0.35) * 0.32 * gain, 0.15);
  }
}

/** A shaker: soft attack, short airy tail. */
function shaker(t0, gain = 1, pan = -0.35) {
  const len = 0.07 * SR;
  let p1 = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const n = noise();
    const hp = n - p1;
    p1 = n;
    const env = Math.min(1, s / 0.008) * Math.exp(-s * 38);
    addStereo(Math.floor(t0 * SR) + k, hp * env * 0.07 * gain, pan);
  }
}

function openHat(t0, gain = 1) {
  const len = 0.2 * SR;
  let p1 = 0;
  let p2 = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const n = noise();
    const hp = n - 2 * p1 + p2;
    p2 = p1;
    p1 = n;
    addStereo(Math.floor(t0 * SR) + k, hp * Math.exp(-s * 16) * 0.035 * gain, 0.3);
  }
}

/** A hand drum: a pitched thump that bends down. */
function conga(t0, f0, gain = 1, pan = 0.4) {
  const len = 0.25 * SR;
  let phase = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    phase += (2 * Math.PI * f0 * (1 + 0.25 * Math.exp(-s * 40))) / SR;
    addStereo(Math.floor(t0 * SR) + k, Math.sin(phase) * Math.exp(-s * 16) * 0.22 * gain, pan);
  }
}

// ---------- melodic ----------
/** A warm, rounded bass: sine with a touch of second harmonic. */
function bass(t0, dur, note, gain = 1) {
  const f = midi(note);
  const len = dur * SR;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const v = Math.sin(2 * Math.PI * f * s) + 0.25 * Math.sin(4 * Math.PI * f * s) * Math.exp(-s * 6);
    const env = Math.min(1, s / 0.008) * Math.min(1, (dur - s) / 0.03);
    addStereo(Math.floor(t0 * SR) + k, v * env * 0.34 * gain * duck(t0 + s));
  }
}

/** Marimba: a woody fundamental and its bright fourth harmonic, quick decay. */
function marimba(t0, note, gain = 1, pan = 0) {
  const f = midi(note);
  const len = 0.7 * SR;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const v =
      Math.sin(2 * Math.PI * f * s) * Math.exp(-s * 7) +
      0.35 * Math.sin(2 * Math.PI * f * 3.93 * s) * Math.exp(-s * 26) +
      0.08 * Math.sin(2 * Math.PI * f * 9.2 * s) * Math.exp(-s * 60);
    const g = Math.min(1, s / 0.002) * 0.11 * gain * duck(t0 + s);
    add(PL, Math.floor(t0 * SR) + k, v * g * panL(pan));
    add(PR, Math.floor(t0 * SR) + k, v * g * panR(pan));
  }
}

/** Airy pad: detuned saws through a soft low-pass, slow to swell in. */
function pad(t0, dur, notes, gain = 1, bright = 0.03) {
  const len = dur * SR;
  const lps = notes.map(() => [0, 0]);
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const env = Math.min(1, s / 0.6) * Math.min(1, (dur - s) / 0.5);
    let l = 0;
    let r = 0;
    notes.forEach((n, j) => {
      const f = midi(n);
      const sawL = ((f * 1.005 * s) % 1) * 2 - 1;
      const sawR = ((f * 0.995 * s + 0.37) % 1) * 2 - 1;
      lps[j][0] += bright * (sawL - lps[j][0]);
      lps[j][1] += bright * (sawR - lps[j][1]);
      l += lps[j][0];
      r += lps[j][1];
    });
    const g = 0.05 * gain * env * duck(t0 + s);
    add(L, Math.floor(t0 * SR) + k, l * g);
    add(R, Math.floor(t0 * SR) + k, r * g);
  }
}

/** A breathy flute: sine with a little second harmonic, vibrato and air. */
function flute(t0, dur, note, gain = 1, pan = 0.1) {
  const f = midi(note);
  const len = dur * SR;
  let phase = 0;
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * s) * Math.min(1, s / 0.25);
    phase += (2 * Math.PI * f * vib) / SR;
    lp += 0.08 * (noise() - lp);
    const v = Math.sin(phase) + 0.18 * Math.sin(2 * phase) + lp * 0.35;
    const env = Math.min(1, s / 0.05) * Math.min(1, (dur - s) / 0.12);
    addStereo(Math.floor(t0 * SR) + k, v * env * 0.06 * gain * duck(t0 + s), pan);
  }
}

// ---------- transitions ----------
/** A soft swell of filtered noise into `tEnd`. */
function swell(tEnd, length, gain = 1) {
  const t0 = tEnd - length;
  const len = length * SR;
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const p = k / len;
    lp += (0.005 + 0.2 * p * p) * (noise() - lp);
    addStereo(Math.floor(t0 * SR) + k, lp * p * p * 0.3 * gain, Math.sin(p * 6) * 0.4);
  }
}

/** A soft landing: a low boom and a wash of air. */
function landing(t0, gain = 1) {
  const len = 1.6 * SR;
  let phase = 0;
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    phase += (2 * Math.PI * (40 + 40 * Math.exp(-s * 10))) / SR;
    lp += 0.12 * (noise() - lp);
    addStereo(Math.floor(t0 * SR) + k, (Math.sin(phase) * Math.exp(-s * 3) * 0.6 + lp * Math.exp(-s * 3.5) * 0.35) * gain);
  }
}

/** Congas rolling faster into `tEnd`, instead of a snare roll. */
function congaRoll(tEnd, length) {
  const t0 = tEnd - length;
  let t = t0;
  let i = 0;
  while (t < tEnd - 0.01) {
    const p = (t - t0) / length;
    conga(t, i % 2 ? 210 : 280, 0.6 + 0.9 * p, i % 2 ? 0.4 : -0.4);
    t += p < 0.5 ? BEAT / 2 : S16;
    i++;
  }
}

// ---------- arrangement ----------
// Intro: a marimba chord and a soft kick on the logo and each title word.
for (const t of plan.slams) {
  kick(t, 0.7);
  CHORDS[0].forEach((n, j) => marimba(t + j * 0.025, n + 12, 0.9, (j - 1.5) * 0.3));
}
// Build: a pad swelling up and marimba arpeggios getting busier.
const buildFrom = plan.slams[plan.slams.length - 1] + BEAT;
pad(0.5, plan.drop - 0.5, CHORDS[0], 1.6, 0.02);
for (let t = buildFrom; t < plan.drop - 0.01; t += S16 * 2) {
  const p = (t - buildFrom) / (plan.drop - buildFrom);
  marimba(t, CHORDS[0][Math.floor((t - buildFrom) / (S16 * 2)) % 4] + 24, 0.4 + 0.6 * p, 0.3);
}
swell(plan.drop, plan.drop - buildFrom);
congaRoll(plan.drop, 1);

// Breakdowns: pad, marimba and shaker only, then congas back into the groove.
for (const [a, b] of BREAKS) {
  for (let t = a; t < b - 0.01; t += BAR) pad(t, Math.min(BAR, b - t) + 0.3, CHORDS[chordAt(t)], 2.4, 0.03);
  for (let t = a; t < b - 0.01; t += S16 * 3) marimba(t, CHORDS[chordAt(t)][Math.floor((t - a) / (S16 * 3)) % 4] + 12, 0.55, 0.25);
  for (let t = a; t < b - 0.01; t += S16 * 2) shaker(t, 0.5);
  const build = Math.min(1.5, (b - a) / 2);
  swell(b, build, 0.8);
  congaRoll(b, Math.min(1, build));
  landing(b, 0.7);
}

// Groove.
// Marimba: syncopated sixteenths walking the chord an octave up.
const MARIMBA = [
  [0, 0], [3, 2], [6, 1], [8, 3], [10, 2], [13, 0], [14, 1],
];
// Bass: deep-house offbeats, with an octave hop and a fifth.
const BASS = [
  [2, 0, 1.6], [6, 0, 1.6], [10, 12, 1.2], [13, 7, 1], [14, 0, 1.6],
];
// Flute: a two-bar phrase on chord tones, for the second half.
const FLUTE = [
  [0, 6, 2], [6, 4, 1], [10, 6, 0], [16, 3, 1], [19, 3, 2], [22, 10, 3],
];
const liftFrom = plan.cues[3] ?? 25;
for (let t = 0; t < DUR; t += BAR) {
  const c = chordAt(t);
  const chord = CHORDS[c];
  for (let i = 0; i < 16; i++) {
    const at = t + i * S16 + (i % 2 ? SWING : 0);
    if (!grooveOn(at)) continue;
    if (i % 4 === 0) kick(at);
    if (i === 4 || i === 12) rim(at);
    if (i % 4 === 2) openHat(at, 0.8);
    shaker(at, i % 4 === 2 ? 1 : i % 2 ? 0.7 : 0.45);
    if (i === 3 || i === 11) conga(at, 280, 0.8, -0.4);
    if (i === 7 || i === 14) conga(at, 210, 0.9, 0.4);
  }
  if (!grooveOn(t + 0.01)) continue;
  for (const [i, note, len] of BASS) bass(t + i * S16 + (i % 2 ? SWING : 0), S16 * len, ROOTS[c] + note);
  for (const [i, idx] of MARIMBA) marimba(t + i * S16 + (i % 2 ? SWING : 0), chord[idx] + 12, 1, i % 4 < 2 ? -0.3 : 0.3);
  pad(t, BAR + 0.3, chord, 0.9, 0.03);
  // Flute phrase every other bar, from the fourth cue on.
  if (t >= liftFrom && Math.floor(t / BAR) % 2 === 0) {
    const next = CHORDS[(c + 1) % 4];
    for (const [i, len, idx] of FLUTE) {
      const ch = i < 16 ? chord : next;
      flute(t + i * S16, S16 * len, ch[idx] + 24, 1);
    }
  }
}

// Outro: one last marimba chord ringing into the fade.
CHORDS[0].forEach((n, j) => marimba(plan.outro + j * 0.03, n + 12, 1, (j - 1.5) * 0.3));
pad(plan.outro, DUR - plan.outro + 1.5, CHORDS[0], 1.3, 0.025);

// Drop and scene cuts.
landing(plan.drop, 0.9);
for (const cue of plan.cues) {
  if (BREAKS.some(([, b]) => Math.abs(b - cue) < 0.01)) continue; // the breakdown already lands it
  swell(cue, BEAT, 0.6);
  landing(cue, 0.35);
}

// ---------- marimba echo: dotted eighths, bouncing left to right ----------
{
  const d = Math.floor(S16 * 3 * SR);
  const fb = 0.38;
  for (let i = d; i < N; i++) {
    PL[i] += PR[i - d] * fb;
    PR[i] += PL[i - d] * fb;
  }
  for (let i = 0; i < N; i++) {
    L[i] += PL[i];
    R[i] += PR[i];
  }
}

// ---------- warm stereo room ----------
for (const [dl, dr, fb] of [
  [0.0297, 0.0371, 0.25],
  [0.0411, 0.0437, 0.22],
  [0.0533, 0.0491, 0.2],
  [0.0719, 0.0683, 0.16],
]) {
  const a = Math.floor(dl * SR);
  const b = Math.floor(dr * SR);
  for (let i = 0; i < N; i++) {
    if (i >= a) L[i] += L[i - a] * fb;
    if (i >= b) R[i] += R[i - b] * fb;
  }
}

// ---------- UI sounds, added dry after the room ----------
/** A mouse click: a short bright tick with a little body under it. */
function uiClick(t0, gain = 1) {
  const len = 0.05 * SR;
  let prev = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    const n = noise();
    const hp = n - prev;
    prev = n;
    const body = Math.sin(2 * Math.PI * 1900 * s) * Math.exp(-s * 160) * 0.6;
    addStereo(Math.floor(t0 * SR) + k, (hp * Math.exp(-s * 260) * 0.5 + body) * 0.55 * gain, 0.1);
  }
}

/** A keystroke: softer and lower than a click. */
function keyTap(t0, gain = 1) {
  const len = 0.04 * SR;
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const s = k / SR;
    lp += 0.3 * (noise() - lp);
    const tone = Math.sin(2 * Math.PI * 900 * s) * Math.exp(-s * 120) * 0.4;
    addStereo(Math.floor(t0 * SR) + k, (lp * Math.exp(-s * 180) + tone) * 0.4 * gain, -0.1);
  }
}

/** Bell notes; by default two, up a fourth: the score saved. */
function chime(t0, gain = 1, notes = [[0, 84], [0.09, 89]]) {
  for (const [dt, note] of notes) {
    const f = midi(note);
    const len = 0.9 * SR;
    for (let k = 0; k < len; k++) {
      const s = k / SR;
      const v = (Math.sin(2 * Math.PI * f * s) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * s) * Math.exp(-s * 6)) * Math.exp(-s * 4.5);
      addStereo(Math.floor((t0 + dt) * SR) + k, v * 0.16 * gain, dt ? 0.3 : -0.3);
    }
  }
}

/** A rising glitter of bell notes for the confetti, up the F major scale. */
function sparkle(t0) {
  [77, 81, 84, 88, 89, 93, 96].forEach((note, i) => chime(t0 + i * 0.06, 0.55 - i * 0.04, [[0, note]]));
}

for (const t of plan.clicks) uiClick(t);
for (const t of plan.keys) keyTap(t);
for (const t of plan.chimes) chime(t);
for (const t of plan.sparkle) {
  sparkle(t);
  landing(t, 0.4);
}

// ---------- master: fades, glue, normalize ----------
const endSample = Math.min(N, Math.floor((DUR + 1.5) * SR));
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fadeOut = i >= endSample ? 0 : Math.min(1, (DUR + 1.5 - t) / 2.5);
  L[i] = Math.tanh(L[i] * 1.2 * fadeOut);
  R[i] = Math.tanh(R[i] * 1.2 * fadeOut);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.93 / (peak || 1);

const buf = Buffer.alloc(44 + endSample * 4);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + endSample * 4, 4);
buf.write("WAVEfmt ", 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(endSample * 4, 40);
for (let i = 0; i < endSample; i++) {
  buf.writeInt16LE(Math.round(L[i] * norm * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(R[i] * norm * 32767), 46 + i * 4);
}

mkdirSync(join(root, "public"), { recursive: true });
const wav = join(root, `public/music-${id}.wav`);
const mp3 = join(root, `public/music-${id}.mp3`);
writeFileSync(wav, buf);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-b:a", "256k", mp3]);
unlinkSync(wav);
console.log(`Wrote ${mp3} (${(endSample / SR).toFixed(1)}s, drop at ${plan.drop}s, ${plan.cues.length} cues, ${BREAKS.length} breakdowns)`);
