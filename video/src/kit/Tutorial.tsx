import { useMemo, type ComponentType } from "react";
import { AbsoluteFill, Audio, getStaticFiles, interpolate, Sequence, staticFile } from "remotion";
import { LIGHT } from "./theme";
import type { Scene, States, Walkthrough } from "./timeline";
import { WalkScene } from "./Walkthrough";

export type TutorialProps = { music?: string; states?: States | null };

export type VideoDef = {
  /** Folder under src/videos and public/shots; also the music file's suffix. */
  id: string;
  /** Remotion composition id. */
  composition: string;
  scenes: readonly Scene[];
  /** The explainer scenes. Walkthrough scenes are drawn from `walks`. */
  components: Record<string, ComponentType>;
  /** One builder per walkthrough scene, over the captured states. */
  walks: Record<string, (S: States) => Walkthrough>;
};

/** Where capture writes a video's states; read by calculateMetadata in Root. */
export const statesFile = (id: string) => `shots/${id}/states.json`;

function Missing({ id }: { id: string }) {
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontSize: 40, color: "#7b8794" }}>
      No captures yet: run `npm run capture -- {id}`
    </AbsoluteFill>
  );
}

/** Plays a video's scenes back to back, with its soundtrack if one was made. */
export function makeTutorial(def: VideoDef) {
  const total = def.scenes.reduce((s, x) => s + x.frames, 0);
  return function Tutorial({ music = `music-${def.id}.mp3`, states }: TutorialProps) {
    const walks = useMemo(
      () => (states ? Object.fromEntries(Object.entries(def.walks).map(([k, build]) => [k, build(states)])) : null),
      [states],
    );
    const hasMusic = Boolean(music) && getStaticFiles().some((f) => f.name === music);
    let from = 0;
    return (
      <AbsoluteFill style={{ background: LIGHT.top }}>
        {def.scenes.map(({ name, frames, walk }) => {
          let body;
          if (walk) {
            body = walks && states ? <WalkScene walk={walks[name]} states={states} /> : <Missing id={def.id} />;
          } else {
            const Scene = def.components[name];
            if (!Scene) throw new Error(`${def.id}: no component for scene "${name}"`);
            body = <Scene />;
          }
          const seq = (
            <Sequence key={name} name={name} from={from} durationInFrames={frames}>
              {body}
            </Sequence>
          );
          from += frames;
          return seq;
        })}
        {hasMusic && (
          <Audio
            src={staticFile(music)}
            volume={(f) => interpolate(f, [0, 2, total - 30, total], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
          />
        )}
      </AbsoluteFill>
    );
  };
}
