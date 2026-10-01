import { Composition, getStaticFiles, staticFile } from "remotion";
import { makeTutorial, statesFile, type TutorialProps, type VideoDef } from "./kit/Tutorial";
import { FPS, type States } from "./kit/timeline";
import { VIDEOS } from "./videos";

async function loadStates(id: string): Promise<States | null> {
  const file = statesFile(id);
  if (!getStaticFiles().some((f) => f.name === file)) return null;
  const res = await fetch(staticFile(file));
  return ((await res.json()) as { states: States }).states;
}

const TUTORIALS = new Map(VIDEOS.map((def) => [def.id, makeTutorial(def)]));

function Video({ def }: { def: VideoDef }) {
  const total = def.scenes.reduce((s, x) => s + x.frames, 0);
  return (
    <Composition
      id={def.composition}
      component={TUTORIALS.get(def.id)!}
      durationInFrames={total}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{} as TutorialProps}
      calculateMetadata={async ({ props }) => ({ props: { ...props, states: await loadStates(def.id) } })}
    />
  );
}

export function RemotionRoot() {
  return (
    <>
      {VIDEOS.map((def) => (
        <Video key={def.id} def={def} />
      ))}
    </>
  );
}
