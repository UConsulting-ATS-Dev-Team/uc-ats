import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, DISPLAY, LIGHT } from "./theme";

/** Snappy in-out curve for camera, cursor and scroll moves. */
export const EASE = Easing.bezier(0.65, 0, 0.2, 1);

/** Value at `frame` along sorted keyframes, eased between each pair. */
export function keyed<T extends { f: number }>(keys: T[], frame: number, pick: (k: T) => number, ease = EASE) {
  if (keys.length === 0) return 0;
  if (frame <= keys[0].f) return pick(keys[0]);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (frame < b.f) {
      if (b.f === a.f) return pick(b);
      const t = ease((frame - a.f) / (b.f - a.f));
      return pick(a) + (pick(b) - pick(a)) * t;
    }
  }
  return pick(keys[keys.length - 1]);
}

/** The white-to-grey stage, with two slow blue glows for depth. */
export function Stage({ children }: { children?: ReactNode }) {
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();
  const t = frame / 30;
  const glow = (x: number, y: number, r: number, o: number) => (
    <div
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(12,116,193,${o}) 0%, rgba(12,116,193,0) 65%)`,
      }}
    />
  );
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${LIGHT.top} 0%, ${LIGHT.bottom} 100%)`, overflow: "hidden" }}>
      {glow(W * (0.12 + 0.04 * Math.sin(t * 0.4)), H * (0.95 + 0.03 * Math.cos(t * 0.5)), W * 0.42, 0.1)}
      {glow(W * (0.9 + 0.03 * Math.cos(t * 0.35)), H * (0.1 + 0.04 * Math.sin(t * 0.45)), W * 0.36, 0.08)}
      {children}
    </AbsoluteFill>
  );
}

/**
 * Coffee Chats 101's headline: Montserrat, navy, the key words in UC blue,
 * each word blurring up into place, and out the same way.
 */
export function Headline({
  text,
  accent = [],
  size = 56,
  delay = 0,
  exitAt,
  stagger = 2,
  color = C.navy,
  accentColor = C.blue,
  weight = 800,
  align = "center",
  style,
}: {
  text: string;
  accent?: number[];
  size?: number;
  delay?: number;
  exitAt?: number;
  stagger?: number;
  color?: string;
  accentColor?: string;
  weight?: number;
  align?: CSSProperties["textAlign"];
  style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(" ");
  return (
    <div
      style={{
        fontFamily: DISPLAY,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 1.12,
        letterSpacing: "-0.025em",
        color,
        textAlign: align,
        ...style,
      }}
    >
      {words.map((word, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 16, stiffness: 140, mass: 0.7 } });
        const out =
          exitAt === undefined ? 0 : interpolate(frame - exitAt - i, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const vis = Math.min(1, p) * (1 - out);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              color: accent.includes(i) ? accentColor : undefined,
              opacity: vis,
              filter: `blur(${(1 - Math.min(1, p)) * 14 + out * 10}px)`,
              transform: `translateY(${(1 - p) * 26 - out * 14}px) scale(${0.94 + 0.06 * Math.min(1, p)})`,
            }}
          >
            {word}
            {i < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
}

/** The small grey line above a headline. */
export function Kicker({ children, delay = 0, exitAt, size = 22, color = LIGHT.muted }: {
  children: ReactNode;
  delay?: number;
  exitAt?: number;
  size?: number;
  color?: string;
}) {
  const frame = useCurrentFrame();
  const inP = interpolate(frame - delay, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = exitAt === undefined ? 0 : interpolate(frame - exitAt, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        fontFamily: DISPLAY,
        fontWeight: 600,
        fontSize: size,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color,
        textAlign: "center",
        opacity: inP * (1 - out),
        filter: `blur(${(1 - inP) * 8 + out * 6}px)`,
      }}
    >
      {children}
    </div>
  );
}

/** Fades a scene in from white and back out, so cuts between scenes breathe. */
export function SceneFade({ frames, children, inF = 6, outF = 6 }: { frames: number; children: ReactNode; inF?: number; outF?: number }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, inF, frames - outF, frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}
