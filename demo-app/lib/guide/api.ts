"use client";

import type { GuideStep, PageState } from "showme-recorder";
import { BACKEND_TOKEN, BACKEND_URL } from "@/lib/recording.ts";

const headers = (json = false): HeadersInit => ({
  ...(BACKEND_TOKEN ? { "x-showme-token": BACKEND_TOKEN } : {}),
  ...(json ? { "content-type": "application/json" } : {}),
});

export interface StepsDoc {
  recording_id: string;
  workflow: { title: string | null; summary: string | null; text_provider?: string | null };
  start_path: string | null;
  counts: { kept: number };
  steps: (GuideStep & { decision: { keep: boolean } })[];
}

export interface RecordingListItem {
  id: string;
  state: string;
  counts?: { kept: number };
}

export async function latestReadyRecording(): Promise<string | null> {
  const res = await fetch(`${BACKEND_URL}/recordings`, { headers: headers(), cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't list recordings (HTTP ${res.status})`);
  const list = (await res.json()) as RecordingListItem[];
  return list.find((r) => r.state === "steps_ready" && (r.counts?.kept ?? 0) > 0)?.id ?? null;
}

export async function getSteps(id: string): Promise<StepsDoc> {
  const res = await fetch(`${BACKEND_URL}/recordings/${id}/steps`, { headers: headers(), cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't load steps (HTTP ${res.status})`);
  return (await res.json()) as StepsDoc;
}

export interface ClefAnswers {
  step_done: { noul: number };
  stuck: { noul: number };
  current_step: { choice: string; probabilities: Record<string, number>; confidence: number };
}

export interface CheckResult {
  step_number: number;
  trigger: "ambiguous" | "idle" | "off_track";
  provider: string;
  model: string;
  latency_ms: number;
  answers: ClefAnswers;
  thresholds: { step_done: number; stuck: number; idle_seconds: number; min_seconds_between_calls: number };
}

export interface LearnerState {
  path: string;
  page_state: PageState;
  seconds_on_step: number;
  wrong_attempts: number;
  recent_actions: { type: string; element: string; seconds_ago: number }[];
}

/** Returns null when rate limited (429): the caller simply tries again later. */
export async function checkWithClef(
  id: string,
  stepNumber: number,
  trigger: CheckResult["trigger"],
  learner: LearnerState,
): Promise<CheckResult | null> {
  const res = await fetch(`${BACKEND_URL}/practice/${id}/check`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ step_number: stepNumber, trigger, learner }),
  });
  if (res.status === 429) return null;
  if (!res.ok) throw new Error(`Clef check failed (HTTP ${res.status}): ${(await res.text()).slice(0, 120)}`);
  return (await res.json()) as CheckResult;
}
