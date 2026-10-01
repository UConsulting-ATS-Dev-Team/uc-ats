import type { CSSProperties, ReactNode } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, DISPLAY } from "./theme";

/** Coffee Chats 101's flat person: round head, rounded shoulders. */
export function Person({ size = 60, color = C.blue, style }: { size?: number; color?: string; style?: CSSProperties }) {
  return (
    <div style={{ position: "relative", width: size, height: size * 1.25, ...style }}>
      <div style={{ position: "absolute", left: size * 0.27, top: 0, width: size * 0.46, height: size * 0.46, borderRadius: "50%", background: color }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: size,
          height: size * 0.7,
          borderRadius: `${size * 0.5}px ${size * 0.5}px ${size * 0.08}px ${size * 0.08}px`,
          background: color,
        }}
      />
    </div>
  );
}

/** Material icons the app itself uses, as inline paths. */
export const ICONS = {
  resume: "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm2 16H8v-2h8zm0-4H8v-2h8zm-3-5V3.5L18.5 9z",
  short: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z",
  video: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11z",
  star: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
} as const;

export function Icon({ d, size = 40, color = C.navy }: { d: string; size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path d={d} fill={color} />
    </svg>
  );
}

/** Springs its children up into place at `at`. */
export function Pop({ at, children, y = 40, from = 0.85, style }: { at: number; children: ReactNode; y?: number; from?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - at, fps, config: { damping: 13, stiffness: 160, mass: 0.7 } });
  return (
    <div
      style={{
        opacity: Math.min(1, p * 1.6),
        filter: `blur(${Math.max(0, 1 - p) * 10}px)`,
        transform: `translateY(${(1 - p) * y}px) scale(${from + (1 - from) * p})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Small white card, the building block of the explainer scenes. */
export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 22,
        boxShadow: "0 24px 50px -24px rgba(4,39,66,0.35), 0 0 0 1px rgba(4,39,66,0.06)",
        fontFamily: DISPLAY,
        color: C.navy,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A number counting toward `to`, shown with up to two decimals and no trailing zeros. */
export function Count({ to, start, duration = 24, decimals = 2 }: { to: number; start: number; duration?: number; decimals?: number }) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [start, start + duration], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const v = to * (1 - Math.pow(1 - t, 3));
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{String(Math.round(v * 10 ** decimals) / 10 ** decimals)}</span>;
}
