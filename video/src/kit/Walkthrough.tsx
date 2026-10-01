import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { AppView, BrowserWindow, currentUrl } from "./App";
import { Headline, Kicker, Stage } from "./Light";
import { APP_H, APP_W, type States, type Walkthrough as Walk } from "./timeline";

/** The app at this size inside the window. */
const S = 0.9;
const BAR = 46;

/** The app in a browser window, driven by one walkthrough, under its headlines. */
export function WalkScene({ walk: WALK, states: STATES }: { walk: Walk; states: States }) {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const winW = APP_W * S;
  const winH = APP_H * S + BAR;
  const left = (W - winW) / 2;
  const top = H - winH - 26;

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 110 } });
  const leave = interpolate(frame, [WALK.frames - 12, WALK.frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <Stage>
      {WALK.heads.map((h) => {
        if (frame < h.f0 - 2 || frame > h.f1 + 2) return null;
        const exitAt = h.f1 - 9;
        return (
          <div key={h.f0} style={{ position: "absolute", left: 0, right: 0, top: 34, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <Kicker delay={h.f0} exitAt={exitAt}>{h.eyebrow}</Kicker>
            <Headline text={h.text} accent={h.accent} size={54} delay={h.f0 + 3} exitAt={exitAt} />
          </div>
        );
      })}
      <BrowserWindow
        width={winW}
        url={currentUrl(WALK, frame)}
        style={{
          left,
          top,
          opacity: Math.min(1, enter * 1.4) * (1 - leave),
          transform: `translateY(${(1 - enter) * 160 + leave * 40}px) scale(${0.9 + 0.1 * enter - leave * 0.04})`,
          transformOrigin: "50% 100%",
        }}
      >
        <div style={{ position: "relative", width: winW, height: APP_H * S, overflow: "hidden" }}>
          <div style={{ position: "absolute", width: APP_W, height: APP_H, transform: `scale(${S})`, transformOrigin: "0 0" }}>
            <AppView w={WALK} states={STATES} />
          </div>
        </div>
      </BrowserWindow>
    </Stage>
  );
}
