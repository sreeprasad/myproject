// Shared data shapes for ShowMe recordings. Everything here is JSON-serializable.
// Coordinates are viewport CSS px unless a name says otherwise.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number; // window.innerWidth (CSS px)
  h: number; // window.innerHeight (CSS px)
  dpr: number;
}

export type IdentifierKind = "testid" | "role_name" | "css_path";

export interface ElementIdentifiers {
  testid?: string;
  role?: string;
  name?: string; // accessible name (never a sensitive value)
  css_path: string;
  used: IdentifierKind; // highest-priority identifier available
}

export interface TargetInfo {
  tag: string;
  identifiers: ElementIdentifiers;
  text?: string; // visible text, omitted for sensitive elements
  label?: string; // associated form label
  bbox: Rect;
  sensitive: boolean;
  input_type?: string;
}

export type EventType =
  | "click"
  | "input"
  | "select"
  | "checkbox"
  | "navigation"
  | "scroll"
  | "enter"
  | "resize";

export interface PageState {
  url: string;
  title: string;
  headings: string[];
  buttons: string[];
  links: string[];
  fields: { label: string; filled: boolean }[];
  dialog?: string;
  status_texts: string[];
}

export interface RecordedEvent {
  id: string; // "e0001"
  type: EventType;
  epoch: number; // performance.timeOrigin + performance.now()
  t?: number; // ms since capture start (epoch - start_epoch); filled by the host
  url: string;
  viewport: Viewport;
  x?: number; // click point
  y?: number;
  target?: TargetInfo;
  value?: string | boolean; // only when safe
  value_masked?: boolean;
  scroll?: { x: number; y: number };
  page_state?: PageState;
  frames?: { before?: string; after?: string }; // file names relative to the recording dir
}

export interface TrackBox extends Rect {
  key: string; // stable per element for interpolation
  kind: string; // data-sensitive value or detected kind (password, phone, ...)
}

export interface TrackSample {
  epoch: number;
  viewport: Viewport;
  boxes: TrackBox[];
}

export interface FrameSizeChange {
  epoch: number;
  t?: number;
  width: number;
  height: number;
}

export interface CaptureInfo {
  source: "getDisplayMedia" | "tabCapture";
  start_epoch: number; // t = 0
  stop_epoch?: number;
  initial_viewport: Viewport;
  track_settings_start: { width?: number; height?: number; frameRate?: number };
  frame_sizes: FrameSizeChange[]; // decoded frame size at start + every change
  user_agent: string;
}

/** What gets uploaded: the event log, capture metadata and masked frames. Never video. */
export interface RecordingBundle {
  events: RecordedEvent[];
  capture: CaptureInfo;
}
