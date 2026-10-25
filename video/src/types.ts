import type { CaptureInfo, RecordedEvent, TrackSample } from "showme-recorder/types";
import type { NormalizeTransform } from "showme-recorder/timeline";

export interface Transform extends NormalizeTransform {
  source_start_ms: number;
  duration_ms: number;
}

/** Everything a composition needs; the render script loads these JSON files from data/<id>/. */
export interface RecordingProps extends Record<string, unknown> {
  recordingId: string;
  videoFile: string; // relative to the recording dir (public dir at render time)
  transform: Transform;
  capture: CaptureInfo;
  events: RecordedEvent[];
  tracks: TrackSample[];
}
