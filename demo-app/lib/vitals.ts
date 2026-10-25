import type { VitalsEntry } from "./types.ts";

export interface VitalsForm {
  systolic: string;
  diastolic: string;
  heartRate: string;
  temperatureF: string;
  spo2: string;
  pain: string;
}

type Range = { min: number; max: number; integer: boolean; label: string };

// Plausibility ranges (catch typos, not clinical judgement).
const RANGES: Record<keyof VitalsForm, Range> = {
  systolic: { min: 60, max: 250, integer: true, label: "Systolic" },
  diastolic: { min: 30, max: 150, integer: true, label: "Diastolic" },
  heartRate: { min: 30, max: 220, integer: true, label: "Heart rate" },
  temperatureF: { min: 90, max: 110, integer: false, label: "Temperature" },
  spo2: { min: 50, max: 100, integer: true, label: "SpO2" },
  pain: { min: 0, max: 10, integer: true, label: "Pain score" },
};

export function validateVitals(form: VitalsForm): {
  errors: Partial<Record<keyof VitalsForm, string>>;
  entry: Omit<VitalsEntry, "recordedAt"> | null;
} {
  const errors: Partial<Record<keyof VitalsForm, string>> = {};
  const values: Partial<Record<keyof VitalsForm, number>> = {};

  for (const key of Object.keys(RANGES) as (keyof VitalsForm)[]) {
    const r = RANGES[key];
    const raw = form[key].trim();
    if (raw === "") {
      errors[key] = `${r.label} is required`;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || (r.integer && !Number.isInteger(n))) {
      errors[key] = `${r.label} must be a ${r.integer ? "whole " : ""}number`;
      continue;
    }
    if (n < r.min || n > r.max) {
      errors[key] = `${r.label} must be ${r.min}–${r.max}`;
      continue;
    }
    values[key] = n;
  }

  if (values.systolic !== undefined && values.diastolic !== undefined && values.diastolic >= values.systolic) {
    errors.diastolic = "Diastolic must be lower than systolic";
  }

  if (Object.keys(errors).length > 0) return { errors, entry: null };
  return {
    errors,
    entry: {
      systolic: values.systolic!,
      diastolic: values.diastolic!,
      heartRate: values.heartRate!,
      temperatureF: values.temperatureF!,
      spo2: values.spo2!,
      pain: values.pain!,
    },
  };
}
