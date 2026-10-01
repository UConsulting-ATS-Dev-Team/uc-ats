import type { CSSProperties, ReactNode } from "react";
import { Freeze, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { APP_H, APP_W, SIDEBAR_W, TOPBAR_H, type Box, type States, type Walkthrough } from "./timeline";
import { C, BODY } from "./theme";
import { keyed } from "./Light";

const shot = (file: string) => staticFile(`shots/${file}`);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
/** Last entry at or before `frame`, and the one before it. */
function at<T extends { f: number }>(list: T[], frame: number): [T | undefined, T | undefined, number] {
  let i = -1;
  for (let k = 0; k < list.length; k++) if (list[k].f <= frame) i = k;
  return [list[i], list[i - 1], i];
}

// ---------- browser window ----------

/** A macOS browser window around the app, URL bar and all. */
export function BrowserWindow({ width, url, children, style }: { width: number; url: string; children: ReactNode; style?: CSSProperties }) {
  const bar = 46;
  const dot = (c: string) => <div style={{ width: 13, height: 13, borderRadius: 99, background: c }} />;
  return (
    <div
      style={{
        position: "absolute",
        width,
        borderRadius: 14,
        overflow: "hidden",
        background: "#fff",
        boxShadow: "0 40px 90px -30px rgba(4,39,66,0.45), 0 12px 30px -12px rgba(4,39,66,0.25), 0 0 0 1px rgba(4,39,66,0.08)",
        ...style,
      }}
    >
      <div style={{ height: bar, background: "#f3f5f8", borderBottom: "1px solid #e3e7ed", display: "flex", alignItems: "center", padding: "0 18px", gap: 8 }}>
        {dot("#ff5f57")}
        {dot("#febc2e")}
        {dot("#28c840")}
        <div style={{ display: "flex", gap: 14, marginLeft: 22, color: "#9aa4b1", fontSize: 18, fontFamily: BODY }}>
          <span>‹</span>
          <span>›</span>
        </div>
        <div
          style={{
            margin: "0 auto",
            transform: "translateX(-60px)",
            width: 520,
            height: 30,
            borderRadius: 8,
            background: "#fff",
            border: "1px solid #e3e7ed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontFamily: BODY,
            fontSize: 15,
            color: "#4b5563",
          }}
        >
          <svg width="12" height="14" viewBox="0 0 12 14">
            <rect x="1" y="6" width="10" height="8" rx="2" fill="#6b7280" />
            <path d="M3.5 6V4a2.5 2.5 0 015 0v2" stroke="#6b7280" strokeWidth="1.6" fill="none" />
          </svg>
          <span>
            uconsultingats.com<span style={{ color: "#9aa4b1" }}>{url}</span>
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}

// ---------- the app inside it ----------

function PageImage({ states, name, scroll }: { states: States; name: string; scroll: number }) {
  const s = states[name];
  if (s.kind === "view") return <Img src={shot(s.file)} style={{ position: "absolute", left: 0, top: 0, width: APP_W, height: APP_H }} />;
  return (
    <>
      <Img src={shot(s.file)} style={{ position: "absolute", left: 0, top: -scroll, width: APP_W, height: s.h }} />
      {/* The top bar and sidebar are fixed in the app, so they come from the
          unscrolled shot and stay put. */}
      <Img
        src={shot(s.chrome!)}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: APP_W,
          height: APP_H,
          clipPath: `polygon(0 0, ${APP_W}px 0, ${APP_W}px ${TOPBAR_H}px, ${SIDEBAR_W}px ${TOPBAR_H}px, ${SIDEBAR_W}px ${APP_H}px, 0 ${APP_H}px)`,
        }}
      />
      {/* Widgets pinned to the viewport (chat launcher, Questions tab), likewise. */}
      {(s.fixed ?? []).map((b, i) => (
        <Img
          key={i}
          src={shot(s.chrome!)}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: APP_W,
            height: APP_H,
            clipPath: `inset(${b.y}px ${APP_W - b.x - b.width}px ${APP_H - b.y - b.height}px ${b.x}px round 12px)`,
          }}
        />
      ))}
    </>
  );
}

function ElImage({ states, name, style }: { states: States; name: string; style?: CSSProperties }) {
  const s = states[name];
  return (
    <Img
      src={shot(s.file)}
      style={{ position: "absolute", left: s.x, top: s.y, width: s.w, height: s.h, borderRadius: 12, ...style }}
    />
  );
}

function Ring({ box, f, life }: { box: Box; f: number; life: number }) {
  const frame = useCurrentFrame();
  const t = frame - f;
  if (t < 0 || t > life) return null;
  const inP = interpolate(t, [0, 7], [0, 1], clamp);
  const out = interpolate(t, [life - 8, life], [1, 0], clamp);
  const pulse = 1 + 0.04 * Math.sin((t / 8) * Math.PI);
  const grow = interpolate(inP, [0, 1], [1.25, 1]) * pulse;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        borderRadius: 10,
        border: `3px solid ${C.blue}`,
        boxShadow: `0 0 0 6px rgba(12,116,193,0.16), 0 0 26px rgba(12,116,193,0.45)`,
        opacity: inP * out,
        transform: `scale(${grow})`,
      }}
    />
  );
}

const ARROW = (
  <svg viewBox="0 0 28 28" width="28" height="28">
    <path d="M6 3 L6 22 L10.6 17.8 L13.8 25 L17 23.6 L13.9 16.6 L20 16.6 Z" fill="#111" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);
const HAND = (
  <svg viewBox="0 0 28 28" width="28" height="28">
    <path
      d="M10 13 V5.5 a1.8 1.8 0 0 1 3.6 0 V12 V10.5 a1.8 1.8 0 0 1 3.6 0 V12.5 a1.8 1.8 0 0 1 3.4 0.4 V13.5 a1.7 1.7 0 0 1 3.2 0.6 V19 c0 3.6 -2.6 6 -6.2 6 h-2.6 c-2.2 0 -3.6 -0.9 -4.8 -2.6 L6 17.6 a1.8 1.8 0 0 1 2.8 -2.2 Z"
      fill="#fff"
      stroke="#111"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);
const IBEAM = (
  <svg viewBox="0 0 28 28" width="28" height="28">
    <path d="M10 4 h3 q1 0 1 1 q0 -1 1 -1 h3 M14 5 V23 M10 24 h3 q1 0 1 -1 q0 1 1 1 h3" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M10 4 h3 q1 0 1 1 q0 -1 1 -1 h3 M14 5 V23 M10 24 h3 q1 0 1 -1 q0 1 1 1 h3" stroke="#111" strokeWidth="1.6" fill="none" strokeLinecap="round" />
  </svg>
);

/** Hot spot of each cursor inside its 28px box. */
const HOT = { arrow: [6, 3], hand: [11, 4], text: [14, 14] } as const;

function Cursor({ w, zoom }: { w: Walkthrough; zoom: number }) {
  const frame = useCurrentFrame();
  const x = keyed(w.cursor, frame, (k) => k.x);
  const y = keyed(w.cursor, frame, (k) => k.y);
  // Take on the target's cursor just before arriving, as a browser does on hover.
  const [k] = at(w.cursor, frame + 3);
  const kind = k?.kind ?? "arrow";
  const near = w.clicks.find((c) => frame >= c - 2 && frame <= c + 8);
  const press = near === undefined ? 1 : interpolate(frame - near, [-2, 1, 8], [1, 0.8, 1], clamp);
  const size = 1.25 / zoom;
  const [hx, hy] = HOT[kind];
  return (
    <>
      {w.clicks.map((c) => {
        const t = frame - c;
        if (t < 0 || t > 20) return null;
        const r = interpolate(t, [0, 18], [8, 46], clamp) / zoom;
        return (
          <div
            key={c}
            style={{
              position: "absolute",
              left: keyed(w.cursor, c, (q) => q.x) - r,
              top: keyed(w.cursor, c, (q) => q.y) - r,
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              background: "rgba(12,116,193,0.18)",
              border: `${3 / zoom}px solid rgba(12,116,193,${interpolate(t, [0, 18], [0.9, 0], clamp)})`,
            }}
          />
        );
      })}
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: 28,
          height: 28,
          transform: `translate(${-hx}px, ${-hy}px) scale(${size * press})`,
          transformOrigin: `${hx}px ${hy}px`,
          filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.3))",
        }}
      >
        {kind === "hand" ? HAND : kind === "text" ? IBEAM : ARROW}
      </div>
    </>
  );
}

const CONFETTI = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#feca57", "#ff9ff3"];
function Confetti({ start }: { start: number }) {
  const frame = useCurrentFrame();
  const t = frame - start;
  if (t < 0 || t > 110) return null;
  return (
    <>
      {Array.from({ length: 70 }, (_, i) => {
        const rnd = (n: number) => {
          const s = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
          return s - Math.floor(s);
        };
        const x0 = rnd(1) * APP_W;
        const delay = rnd(2) * 25;
        const tt = Math.max(0, t - delay);
        const yy = -30 + tt * (7 + rnd(3) * 6) + 0.05 * tt * tt;
        const xx = x0 + Math.sin(tt / (8 + rnd(4) * 6) + i) * 30;
        const size = 8 + rnd(5) * 8;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: xx,
              top: yy,
              width: size,
              height: size * (rnd(6) > 0.5 ? 1 : 0.5),
              borderRadius: rnd(7) > 0.4 ? "50%" : 2,
              background: CONFETTI[i % CONFETTI.length],
              transform: `rotate(${tt * (rnd(8) * 20 - 10)}deg)`,
              opacity: t > 95 ? interpolate(t, [95, 110], [1, 0]) : 1,
            }}
          />
        );
      })}
    </>
  );
}

/** Everything the camera sees: page, dialog, menu, video, rings, cursor. */
export function AppView({ w, states }: { w: Walkthrough; states: States }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Camera, clamped so the edge of the app never comes into view.
  const z = keyed(w.camera, frame, (k) => k.z);
  const half = (v: number, len: number) => Math.min(Math.max(v, len / (2 * z)), len - len / (2 * z));
  const cx = half(keyed(w.camera, frame, (k) => k.x), APP_W);
  const cy = half(keyed(w.camera, frame, (k) => k.y), APP_H);
  const scroll = keyed(w.scroll, frame, (k) => k.y);

  // Page: a short crossfade when it changes, like a route change.
  const [base, prevBase] = at(w.base, frame);
  const baseFade = base && prevBase ? interpolate(frame - base.f, [0, 5], [0, 1], clamp) : 1;

  // Dialog: springs open from nothing, fades shut back to nothing.
  const [dlg, , di] = at(w.dialog, frame);
  let openFrom = -1;
  for (let i = di; i >= 0; i--) {
    if (w.dialog[i].state === null) break;
    openFrom = w.dialog[i].f;
  }
  const open = dlg?.state ? spring({ frame: frame - openFrom, fps, config: { damping: 18, stiffness: 220 } }) : 0;
  const closing = dlg && dlg.state === null && di > 0 ? w.dialog[di - 1] : undefined;
  const closeT = closing ? interpolate(frame - dlg!.f, [0, 9], [1, 0], clamp) : 0;
  const shown = dlg?.state ?? (closeT > 0 ? closing!.state : null);
  const prevDlg = di > 0 ? w.dialog[di - 1] : undefined;
  const swapFade = dlg?.fade && prevDlg?.state ? interpolate(frame - dlg.f, [0, 6], [0, 1], clamp) : 1;
  const presence = dlg?.state ? open : closeT;

  const menu = w.menu.find((m) => frame >= m.f0 && frame < m.f1 + 4);
  const menuP = menu ? Math.min(interpolate(frame - menu.f0, [0, 6], [0, 1], clamp), interpolate(frame - menu.f1, [0, 4], [1, 0], clamp)) : 0;

  const playing = w.play && shown?.startsWith("video-") && frame >= w.play.f0;
  const pb = w.play?.box;
  const vidH = pb ? (pb.width * 9) / 16 : 0;

  return (
    <div
      style={{
        position: "absolute",
        width: APP_W,
        height: APP_H,
        transformOrigin: "0 0",
        transform: `translate(${APP_W / 2 - cx * z}px, ${APP_H / 2 - cy * z}px) scale(${z})`,
      }}
    >
      {prevBase && baseFade < 1 && <PageImage states={states} name={prevBase.state} scroll={scroll} />}
      {base && (
        <div style={{ position: "absolute", inset: 0, opacity: baseFade }}>
          <PageImage states={states} name={base.state} scroll={scroll} />
        </div>
      )}

      {shown && (
        <>
          <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${0.5 * presence})` }} />
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity: Math.min(1, presence * 1.3),
              transform: `scale(${0.94 + 0.06 * presence})`,
              transformOrigin: `${states[shown].x! + states[shown].w / 2}px ${states[shown].y! + states[shown].h / 2}px`,
            }}
          >
            <div style={{ position: "absolute", left: states[shown].x, top: states[shown].y, width: states[shown].w, height: states[shown].h, borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,0.35)" }} />
            {swapFade < 1 && prevDlg?.state && <ElImage states={states} name={prevDlg.state} />}
            <ElImage states={states} name={shown} style={{ opacity: swapFade }} />
            {playing && pb && (
              <div style={{ position: "absolute", left: pb.x, top: pb.y + (pb.height - vidH) / 2, width: pb.width, height: vidH, overflow: "hidden", background: "#000" }}>
                <Sequence from={w.play!.f0} layout="none">
                  <Freeze frame={w.play!.f1 - w.play!.f0} active={frame >= w.play!.f1}>
                    <OffthreadVideo src={staticFile("sample-video.mp4")} muted style={{ width: pb.width, height: vidH }} />
                  </Freeze>
                </Sequence>
              </div>
            )}
          </div>
        </>
      )}

      {menu && (
        <ElImage
          states={states}
          name={menu.state}
          style={{ opacity: menuP, transform: `scale(${0.85 + 0.15 * menuP})`, transformOrigin: "50% 0", boxShadow: "0 12px 30px rgba(0,0,0,0.25)", borderRadius: 8 }}
        />
      )}

      {w.confetti !== null && <Confetti start={w.confetti} />}
      {w.rings.map((r, i) => (
        <Ring key={i} {...r} />
      ))}
      <Cursor w={w} zoom={z} />
    </div>
  );
}

/** Which path the URL bar shows. */
export function currentUrl(w: Walkthrough, frame: number) {
  const [base] = at(w.base, frame);
  return base?.url ?? "/dashboard";
}
