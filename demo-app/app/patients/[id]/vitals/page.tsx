"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { PatientHeader } from "@/components/PatientHeader.tsx";
import { useStore } from "@/lib/store.tsx";
import { validateVitals, type VitalsForm } from "@/lib/vitals.ts";

const EMPTY: VitalsForm = { systolic: "", diastolic: "", heartRate: "", temperatureF: "", spo2: "", pain: "" };

// Workflow B — Record vitals.
export default function VitalsPage() {
  const { id } = useParams<{ id: string }>();
  const { patients, ready, dispatch, notify } = useStore();
  const patient = patients.find((p) => p.id === id);
  const [form, setForm] = useState<VitalsForm>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof VitalsForm, string>>>({});

  if (!ready) return <p className="muted">Loading…</p>;
  if (!patient) {
    return (
      <section>
        <h1>Patient not found</h1>
        <Link href="/patients" className="btn" data-testid="back-to-patients">
          Back to My Patients
        </Link>
      </section>
    );
  }

  const set = (k: keyof VitalsForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateVitals(form);
    setErrors(result.errors);
    if (!result.entry || !patient) return;
    dispatch({ type: "addVitals", id: patient.id, entry: { ...result.entry, recordedAt: new Date().toISOString() } });
    notify("Vitals saved to chart");
    setForm(EMPTY);
  }

  const field = (k: keyof VitalsForm, label: string, unit: string, testid: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div className="field">
      <label htmlFor={k}>
        {label} <span className="muted small">({unit})</span>
      </label>
      <input
        id={k}
        inputMode="decimal"
        autoComplete="off"
        value={form[k]}
        onChange={set(k)}
        aria-invalid={errors[k] ? true : undefined}
        aria-describedby={errors[k] ? `${k}-error` : undefined}
        data-testid={testid}
        {...extra}
      />
      {errors[k] && (
        <span id={`${k}-error`} className="field-error">
          {errors[k]}
        </span>
      )}
    </div>
  );

  return (
    <section>
      <div className="breadcrumbs">
        <Link href="/patients" data-testid="breadcrumb-patients">
          My Patients
        </Link>
        <span aria-hidden="true"> / </span>
        <span>Vitals</span>
      </div>
      <h1>Record Vitals</h1>
      <PatientHeader patient={patient} />

      <div className="two-col">
        <form className="card form" onSubmit={onSubmit} noValidate data-testid="vitals-form">
          <fieldset>
            <legend>Blood pressure</legend>
            <div className="row">
              {field("systolic", "Systolic", "mmHg", "vitals-bp-systolic")}
              {field("diastolic", "Diastolic", "mmHg", "vitals-bp-diastolic")}
            </div>
          </fieldset>
          <fieldset>
            <legend>Measurements</legend>
            <div className="row">
              {field("heartRate", "Heart rate", "bpm", "vitals-heart-rate")}
              {field("temperatureF", "Temperature", "°F", "vitals-temperature")}
              {field("spo2", "SpO2", "%", "vitals-spo2")}
            </div>
            <div className="field">
              <label htmlFor="pain">Pain score (0–10)</label>
              <select id="pain" value={form.pain} onChange={set("pain")} data-testid="vitals-pain">
                <option value="">Select…</option>
                {Array.from({ length: 11 }, (_, i) => (
                  <option key={i} value={String(i)}>
                    {i}
                    {i === 0 ? " – none" : i === 10 ? " – worst" : ""}
                  </option>
                ))}
              </select>
              {errors.pain && <span className="field-error">{errors.pain}</span>}
            </div>
          </fieldset>
          <div className="actions">
            <Link href="/patients" className="btn ghost" data-testid="vitals-cancel">
              Back
            </Link>
            <button type="submit" className="btn primary" data-testid="vitals-save">
              Save vitals
            </button>
          </div>
        </form>

        <aside className="card timeline" data-testid="vitals-timeline" aria-labelledby="timeline-heading">
          <h2 id="timeline-heading">Chart timeline</h2>
          {patient.vitals.length === 0 ? (
            <p className="muted" data-testid="vitals-timeline-empty">
              No vitals recorded today.
            </p>
          ) : (
            <ol>
              {patient.vitals.map((v, i) => (
                <li key={v.recordedAt + i} data-testid={`vitals-entry-${i}`}>
                  <div className="timeline-time">
                    {new Date(v.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div>
                    BP {v.systolic}/{v.diastolic} · HR {v.heartRate} · {v.temperatureF}°F · SpO2 {v.spo2}% · Pain {v.pain}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </section>
  );
}
