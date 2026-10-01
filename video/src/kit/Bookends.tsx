import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Headline, Kicker, Stage } from "./Light";
import { C, DISPLAY, LIGHT } from "./theme";

export type IntroCopy = { title: string; accent: number[]; tagline?: string };
export type CloseCopy = { text: string; accent: number[]; help?: string; helpAccent?: number[] };

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** The bear mark blurring into focus, as Coffee Chats 101 opens. */
function BlurLogo({ size, at = 0, style }: { size: number; at?: number; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const p = interpolate(frame - at, [0, 22], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  return (
    <Img
      src={staticFile("uc-logo.svg")}
      style={{ width: size, height: size, opacity: p, filter: `blur(${(1 - p) * 22}px)`, transform: `scale(${1.08 - 0.08 * p})`, ...style }}
    />
  );
}

export function Intro({ title, accent, tagline = "Every click, start to finish." }: IntroCopy) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // The logo holds centre stage, then lifts to make room for the title.
  const lift = spring({ frame: frame - 48, fps, config: { damping: 18, stiffness: 120 } });
  const out = interpolate(frame, [140, 150], [0, 1], clamp);
  return (
    <Stage>
      <div style={{ position: "absolute", inset: 0, opacity: 1 - out, filter: `blur(${out * 10}px)` }}>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: interpolate(lift, [0, 1], [540, 300]),
            transform: `translate(-50%, -50%) scale(${interpolate(lift, [0, 1], [1, 0.62])})`,
          }}
        >
          <BlurLogo size={360} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 500, display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
          <Kicker delay={58} size={26}>The ATS, step by step</Kicker>
          <Headline text={title} accent={accent} size={title.length > 22 ? 104 : 124} delay={60} stagger={4} weight={800} />
          <Headline text={tagline} size={36} weight={500} color={LIGHT.muted} delay={84} stagger={2} />
        </div>
      </div>
    </Stage>
  );
}

export function Close({ text, accent, help = "Stuck? Use Message an Admin in the sidebar.", helpAccent = [2, 3, 4] }: CloseCopy) {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [130, 150], [1, 0], clamp);
  return (
    <Stage>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, opacity: fade }}>
        <BlurLogo size={190} at={2} />
        <Headline text={text} accent={accent} size={120} delay={14} stagger={5} />
        <div style={{ height: 18 }} />
        <Headline
          text={help}
          accent={helpAccent}
          accentColor={C.blue}
          color={LIGHT.muted}
          weight={500}
          size={34}
          delay={34}
        />
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 48,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: DISPLAY,
          fontWeight: 600,
          fontSize: 22,
          letterSpacing: "0.08em",
          color: LIGHT.muted,
          opacity: interpolate(frame, [40, 55], [0, 1], clamp) * fade,
        }}
      >
        UCONSULTINGATS.COM
      </div>
    </Stage>
  );
}
