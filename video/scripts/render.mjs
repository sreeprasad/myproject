// Usage:
//   npm run render:debug -- <recording-id>     → data/<id>/debug.mp4
// Reads data/<id>/{transform,capture,events,sensitive_tracks}.json and normalized.mp4.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const dataDir = path.resolve(process.env.SHOWME_DATA_DIR ?? path.join(repoRoot, "data"));

const args = process.argv.slice(2);
const debug = args.includes("--debug");
const id = args.find((a) => !a.startsWith("--"));
if (!id) {
  console.error("usage: npm run render:debug -- <recording-id>");
  process.exit(2);
}
if (!debug) {
  console.error("Only --debug rendering exists so far (the full tutorial render arrives in milestone 5).");
  process.exit(2);
}

const recDir = path.join(dataDir, id);
const read = (name) => {
  const p = path.join(recDir, name);
  if (!fs.existsSync(p)) {
    console.error(`missing ${p}${name === "transform.json" ? " — has the backend finished normalizing? (python -m showme_backend.normalize " + id + ")" : ""}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

const inputProps = {
  recordingId: id,
  videoFile: "normalized.mp4",
  transform: read("transform.json"),
  capture: read("capture.json"),
  events: read("events.json"),
  tracks: read("sensitive_tracks.json"),
};

console.log(`bundling… (public dir: ${recDir})`);
const serveUrl = await bundle({
  entryPoint: path.join(here, "..", "src", "index.ts"),
  publicDir: recDir,
});
const composition = await selectComposition({ serveUrl, id: "Debug", inputProps });
const out = path.join(recDir, "debug.mp4");
console.log(`rendering ${composition.width}×${composition.height} @${composition.fps}fps, ${composition.durationInFrames} frames → ${out}`);
let last = -1;
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: out,
  inputProps,
  x264Preset: "veryfast",
  onProgress: ({ progress }) => {
    const pct = Math.floor(progress * 100);
    if (pct % 10 === 0 && pct !== last) {
      last = pct;
      console.log(`  ${pct}%`);
    }
  },
});
console.log(`done: ${out}`);
