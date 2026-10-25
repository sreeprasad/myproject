import { useMemo } from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { buildSegments, segmentAt, toOutput } from "showme-recorder/timeline";
import { interpolateBoxes } from "showme-recorder/tracks";
import type { RecordingProps } from "./types.ts";

const DOT_BEFORE_MS = 100;
const DOT_AFTER_MS = 900;
const PAD_OUT_PX = 8;

/**
 * render:debug — the source video plus ONLY alignment markers:
 *  - a red dot at every click (from video_t-100ms to video_t+900ms), labelled with the event id
 *  - an outline around every sensitive box (interpolated between samples, padded 8px)
 *  - a HUD with video_t and the active segment, to read off any offset
 * If the dots don't land on what was clicked, the clock or coordinate math is wrong.
 */
export const Debug: React.FC<RecordingProps> = ({ videoFile, transform, capture, events, tracks }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Output t=0 is the first source frame; shift into the recorder's video_t timeline.
  const vt = (frame / fps) * 1000 + (transform.source_start_ms ?? 0);

  const segments = useMemo(() => buildSegments(capture, events), [capture, events]);
  const samples = useMemo(
    () => tracks.map((s) => ({ time: s.video_t ?? s.epoch - capture.video_start_epoch, boxes: s.boxes })),
    [tracks, capture.video_start_epoch],
  );
  const clicks = useMemo(() => events.filter((e) => e.type === "click" && e.x !== undefined && e.video_t !== undefined), [events]);

  const seg = segmentAt(segments, vt);
  const boxes = interpolateBoxes(samples, vt).map((b) => {
    const tl = toOutput({ x: b.x, y: b.y }, vt, segments, transform);
    return {
      key: b.key,
      kind: b.kind,
      x: tl.x - PAD_OUT_PX,
      y: tl.y - PAD_OUT_PX,
      w: b.w * tl.scale + PAD_OUT_PX * 2,
      h: b.h * tl.scale + PAD_OUT_PX * 2,
    };
  });

  const unit = Math.max(1, transform.output.w / 1440); // marker size scales with resolution

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo src={staticFile(videoFile)} />

      {boxes.map((b) => (
        <div
          key={b.key}
          style={{
            position: "absolute",
            left: b.x,
            top: b.y,
            width: b.w,
            height: b.h,
            border: `${2 * unit}px solid #ffd60a`,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
          }}
        >
          <span style={{ position: "absolute", top: -14 * unit, left: 0, fontSize: 10 * unit, color: "#ffd60a", fontFamily: "monospace", textShadow: "0 0 2px #000" }}>
            {b.kind}
          </span>
        </div>
      ))}

      {clicks.map((e) => {
        const dt = vt - e.video_t!;
        if (dt < -DOT_BEFORE_MS || dt > DOT_AFTER_MS) return null;
        const p = toOutput({ x: e.x!, y: e.y! }, e.video_t!, segments, transform);
        const opacity = interpolate(dt, [-DOT_BEFORE_MS, 0, DOT_AFTER_MS - 200, DOT_AFTER_MS], [0.4, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const r = 9 * unit;
        return (
          <div key={e.id} style={{ position: "absolute", left: p.x - r, top: p.y - r, opacity }}>
            <div style={{ width: r * 2, height: r * 2, borderRadius: "50%", background: "#ff1f1f", border: `${2 * unit}px solid white` }} />
            <span style={{ position: "absolute", left: r * 2 + 4, top: 0, whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 12 * unit, color: "white", background: "rgba(255,0,0,0.75)", padding: `0 ${4 * unit}px` }}>
              {e.id} {e.target?.identifiers.testid ?? e.target?.identifiers.name ?? ""}
            </span>
          </div>
        );
      })}

      <div
        style={{
          position: "absolute",
          right: 12 * unit,
          top: 12 * unit,
          fontFamily: "monospace",
          fontSize: 13 * unit,
          color: "white",
          background: "rgba(0,0,0,0.7)",
          padding: `${4 * unit}px ${8 * unit}px`,
          borderRadius: 4 * unit,
          lineHeight: 1.4,
        }}
      >
        <div>video_t {(vt / 1000).toFixed(3)}s · frame {frame}</div>
        <div>
          viewport {seg.viewport.w}×{seg.viewport.h}@{seg.viewport.dpr} · src {seg.video.w}×{seg.video.h}
        </div>
      </div>
    </AbsoluteFill>
  );
};
