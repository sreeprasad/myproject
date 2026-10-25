import { Composition, type CalculateMetadataFunction } from "remotion";
import { Debug } from "./Debug.tsx";
import type { RecordingProps } from "./types.ts";

const metadata: CalculateMetadataFunction<RecordingProps> = ({ props }) => {
  const t = props.transform;
  const fps = t.fps;
  return {
    fps,
    width: t.output.w,
    height: t.output.h,
    durationInFrames: Math.max(1, Math.floor((t.duration_ms / 1000) * fps)),
  };
};

// Placeholder props so Remotion Studio can open without a recording; the render script always passes real ones.
const emptyProps: RecordingProps = {
  recordingId: "none",
  videoFile: "normalized.mp4",
  transform: { output: { w: 1280, h: 720 }, fps: 30, sizes: [], source_start_ms: 0, duration_ms: 1000 },
  capture: {
    source: "getDisplayMedia",
    video_start_epoch: 0,
    mime_type: "",
    initial_viewport: { w: 1280, h: 720, dpr: 1 },
    track_settings_start: {},
    frame_sizes: [],
    user_agent: "",
  },
  events: [],
  tracks: [],
};

export const Root: React.FC = () => (
  <>
    <Composition id="Debug" component={Debug} defaultProps={emptyProps} calculateMetadata={metadata} />
    {/* Milestone 5 adds the "Tutorial" composition here (zoom, ring, captions, blur, per-step <Audio> slot). */}
  </>
);
