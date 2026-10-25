import { test } from "node:test";
import assert from "node:assert/strict";
import { INSURANCE_PLANS, seedPatients } from "../lib/seed.ts";
import { validateVitals } from "../lib/vitals.ts";

test("seeds exactly 20 invented patients with unique ids and MRNs", () => {
  const ps = seedPatients();
  assert.equal(ps.length, 20);
  assert.equal(new Set(ps.map((p) => p.id)).size, 20);
  assert.equal(new Set(ps.map((p) => p.mrn)).size, 20);
});

test("phone numbers use the fictional 555-01xx range", () => {
  for (const p of seedPatients()) assert.match(p.phone, /^\(\d{3}\) 555-01\d{2}$/);
});

test("every seeded plan is one of the fictional plans", () => {
  for (const p of seedPatients()) assert.ok((INSURANCE_PLANS as readonly string[]).includes(p.insurancePlan));
});

test("all patients start Scheduled with no vitals", () => {
  for (const p of seedPatients()) {
    assert.equal(p.status, "Scheduled");
    assert.equal(p.vitals.length, 0);
  }
});

test("valid vitals produce an entry", () => {
  const r = validateVitals({ systolic: "122", diastolic: "78", heartRate: "72", temperatureF: "98.6", spo2: "98", pain: "2" });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.entry, { systolic: 122, diastolic: 78, heartRate: 72, temperatureF: 98.6, spo2: 98, pain: 2 });
});

test("out-of-range and missing vitals are rejected", () => {
  const r = validateVitals({ systolic: "300", diastolic: "", heartRate: "72.5", temperatureF: "98.6", spo2: "98", pain: "11" });
  assert.equal(r.entry, null);
  assert.ok(r.errors.systolic && r.errors.diastolic && r.errors.heartRate && r.errors.pain);
});

test("diastolic must be lower than systolic", () => {
  const r = validateVitals({ systolic: "80", diastolic: "90", heartRate: "72", temperatureF: "98.6", spo2: "98", pain: "0" });
  assert.equal(r.entry, null);
  assert.ok(r.errors.diastolic);
});
