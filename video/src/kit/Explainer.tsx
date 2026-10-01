// The pieces every explainer scene is laid out with: a kicker and headline at
// the top, a muted line of supporting copy, and a blur-out at the scene's end.
import type { ReactNode } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Headline, Kicker } from "./Light";
import { LIGHT } from "./theme";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export function Title({ kicker, text, accent, exitAt, top = 110 }: { kicker: string; text: string; accent: number[]; exitAt: number; top?: number }) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <Kicker delay={2} exitAt={exitAt}>{kicker}</Kicker>
      <Headline text={text} accent={accent} size={64} delay={5} exitAt={exitAt} />
    </div>
  );
}

export function Sub({ text, accent = [], at, exitAt, top }: { text: string; accent?: number[]; at: number; exitAt: number; top: number }) {
  return (
    <div style={{ position: "absolute", left: 160, right: 160, top }}>
      <Headline text={text} accent={accent} size={34} weight={500} color={LIGHT.muted} delay={at} stagger={1} exitAt={exitAt} />
    </div>
  );
}

export function Exit({ at, children }: { at: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at, at + 10], [1, 0], clamp);
  return <div style={{ position: "absolute", inset: 0, opacity: o, filter: `blur(${(1 - o) * 8}px)` }}>{children}</div>;
}
