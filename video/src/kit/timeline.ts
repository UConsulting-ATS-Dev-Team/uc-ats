// The vocabulary every tutorial's timeline is written in: which captured state
// is showing, where the camera and cursor are, every click and keystroke, and
// the headline for each step. A video's own timeline.ts builds its walkthroughs
// with `walkBuilder` and lists its scenes; the video and scripts/make-music.mjs
// both read that, so the click sounds and music hits cannot drift off the cuts.
//
// Self-contained on purpose (no imports): Node runs this file directly with
// type stripping, outside the Remotion bundle.

export type Box = { x: number; y: number; width: number; height: number };
export type State = {
  kind: "page" | "el" | "view";
  file: string;
  chrome?: string;
  x?: number;
  y?: number;
  w: number;
  h: number;
  boxes: Record<string, Box>;
  /** Page states: viewport widgets drawn from the chrome shot, not the scrolled page. */
  fixed?: Box[];
  /** Page states: targets inside those widgets, whose boxes are viewport coordinates. */
  fixedKeys?: string[];
};
export type States = Record<string, State>;

export const FPS = 30;
/** 120 BPM: one beat. Every scene length is a multiple of it. */
export const BEAT = 15;

/** The app's own viewport, in CSS pixels; all coordinates use it. */
export const APP_W = 1440;
export const APP_H = 900;
/** Fixed chrome: the top bar and the sidebar stay put while the page scrolls. */
export const TOPBAR_H = 65;
export const SIDEBAR_W = 260;

export type Pt = { x: number; y: number };
export type CursorKind = "arrow" | "hand" | "text";
export type Headline = { f0: number; f1: number; eyebrow: string; text: string; accent: number[] };

export type Walkthrough = {
  frames: number;
  base: { f: number; state: string; url: string }[];
  scroll: { f: number; y: number }[];
  dialog: { f: number; state: string | null; fade?: boolean }[];
  menu: { f0: number; f1: number; state: string }[];
  camera: { f: number; x: number; y: number; z: number }[];
  cursor: { f: number; x: number; y: number; kind: CursorKind }[];
  clicks: number[];
  keys: number[];
  chimes: number[];
  rings: { f: number; box: Box; life: number }[];
  heads: Headline[];
  play: { f0: number; f1: number; box: Box } | null;
  confetti: number | null;
};

export function pad(b: Box, p: number): Box {
  return { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p };
}

export const mid = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * The verbs a walkthrough is written with, over one video's captured states.
 * Call `done(frames)` at the end to get the finished, sorted Walkthrough.
 */
export function walkBuilder(S: States, defaultUrl = "/dashboard") {
  const w: Walkthrough = {
    frames: 0,
    base: [],
    scroll: [{ f: 0, y: 0 }],
    dialog: [],
    menu: [],
    camera: [{ f: 0, x: APP_W / 2, y: APP_H / 2, z: 1 }],
    cursor: [{ f: 0, x: 1180, y: 860, kind: "arrow" }],
    clicks: [],
    keys: [],
    chimes: [],
    rings: [],
    heads: [],
    play: null,
    confetti: null,
  };
  let scroll = 0;
  let cam = w.camera[0];
  let cur = w.cursor[0];

  const st = (name: string) => {
    const s = S[name];
    if (!s) throw new Error(`no captured state "${name}"`);
    return s;
  };
  /** A box from a captured state, in viewport coordinates at the current scroll. */
  const box = (name: string, key: string): Box => {
    const s = st(name);
    const b = s.boxes[key];
    if (!b) throw new Error(`state "${name}" has no box "${key}"`);
    if (s.kind === "page") return s.fixedKeys?.includes(key) ? b : { ...b, y: b.y - scroll };
    if (s.kind === "el") return { ...b, x: b.x + (s.x ?? 0), y: b.y + (s.y ?? 0) };
    return b;
  };
  /** How far a page has to scroll to put `key` `top` pixels below the viewport top. */
  const scrollFor = (name: string, key: string, top = 140) => {
    const s = st(name);
    const b = s.boxes[key];
    if (!b) throw new Error(`state "${name}" has no box "${key}"`);
    return Math.max(0, Math.min(b.y - top, s.h - APP_H));
  };

  const page = (f: number, state: string, url = defaultUrl) => {
    st(state);
    w.base.push({ f, state, url });
  };
  const dialog = (f: number, state: string | null, fade = false) => {
    if (state) st(state);
    w.dialog.push({ f, state, fade });
  };
  const camTo = (f: number, x: number, y: number, z: number, dur = 20) => {
    // Never start a move before the previous one has landed.
    w.camera.push({ ...cam, f: Math.max(f - dur, cam.f) }, { f, x, y, z });
    cam = { f, x, y, z };
  };
  /** Frame the camera on a box, zoomed so it fills about `fill` of the width. */
  const camOn = (f: number, b: Box, zMax = 2, dur = 20, fill = 0.7) => {
    const z = Math.max(1, Math.min(zMax, (APP_W * fill) / b.width, (APP_H * fill) / b.height));
    const c = mid(b);
    camTo(f, c.x, c.y, z, dur);
  };
  /** Centre the camera on a box at a set zoom, for things too wide for camOn to zoom into. */
  const camZoom = (f: number, b: Box, z: number, dur = 20) => {
    const c = mid(b);
    camTo(f, c.x, c.y, z, dur);
  };
  const camReset = (f: number, dur = 16) => camTo(f, APP_W / 2, APP_H / 2, 1, dur);
  const scrollTo = (f0: number, f1: number, y: number) => {
    w.scroll.push({ f: f0, y: scroll }, { f: f1, y });
    scroll = y;
  };
  const move = (f: number, p: Pt, kind: CursorKind = "arrow", travel = 18) => {
    w.cursor.push({ ...cur, f: Math.max(f - travel, cur.f) }, { f, x: p.x, y: p.y, kind });
    cur = { f, x: p.x, y: p.y, kind };
  };
  const click = (f: number) => w.clicks.push(f);
  const ring = (f: number, b: Box, life = 30) => w.rings.push({ f, box: b, life });
  const head = (f0: number, f1: number, eyebrow: string, text: string, accent: number[]) =>
    w.heads.push({ f0, f1, eyebrow, text, accent });
  /** Type into a field: one captured state per keystroke. */
  const type = (f: number, state: string) => {
    w.keys.push(f);
    dialog(f, state);
  };
  /** A keystroke on the page itself (no dialog): swaps the base state. */
  const typePage = (f: number, state: string, url?: string) => {
    w.keys.push(f);
    page(f, state, url ?? w.base[w.base.length - 1]?.url ?? defaultUrl);
  };
  /** Move to a box's centre and click it; `then` runs on the click frame. */
  const press = (f: number, b: Box, kind: CursorKind, then?: () => void, travel = 18) => {
    move(f, mid(b), kind, travel);
    click(f + 4);
    then?.();
  };
  const chime = (f: number) => w.chimes.push(f);

  const done = (frames: number): Walkthrough => {
    w.frames = frames;
    for (const k of ["base", "dialog", "camera", "cursor", "scroll"] as const) {
      (w[k] as { f: number }[]).sort((a, b) => a.f - b.f);
    }
    return w;
  };

  return {
    w,
    st,
    box,
    scrollFor,
    page,
    dialog,
    camTo,
    camOn,
    camZoom,
    camReset,
    scrollTo,
    move,
    click,
    ring,
    head,
    type,
    typePage,
    press,
    chime,
    done,
    get scroll() {
      return scroll;
    },
  };
}

// ---------- scenes ----------

export type Scene = { name: string; frames: number; walk?: boolean };

export function sceneClock(scenes: readonly Scene[]) {
  const total = scenes.reduce((s, x) => s + x.frames, 0);
  const start = (name: string) => {
    let at = 0;
    for (const s of scenes) {
      if (s.name === name) return at;
      at += s.frames;
    }
    throw new Error(`no scene "${name}"`);
  };
  return { total, start };
}

/**
 * What scripts/make-music.mjs needs from a video beyond its scenes: the intro's
 * hits, and the stretches (in frames from the start) where the drums step out
 * so there is room to read.
 */
export type MusicPlan = {
  slams: number[];
  breaks: [number, number][];
};
