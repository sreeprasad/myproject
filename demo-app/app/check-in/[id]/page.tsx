"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PatientHeader } from "@/components/PatientHeader.tsx";
import { INSURANCE_PLANS, ROOMS, VISIT_REASONS } from "@/lib/seed.ts";
import { useStore } from "@/lib/store.tsx";

// Workflow A — Patient check-in.
export default function CheckInPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { patients, ready, dispatch, notify } = useStore();
  const patient = patients.find((p) => p.id === id);

  const [phone, setPhone] = useState("");
  const [insurancePlan, setInsurancePlan] = useState("");
  const [memberId, setMemberId] = useState("");
  const [idVerified, setIdVerified] = useState(false);
  const [consentSigned, setConsentSigned] = useState(false);
  const [visitReason, setVisitReason] = useState("");
  const [room, setRoom] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Prefill from the chart once the store has loaded.
  useEffect(() => {
    if (!patient) return;
    setPhone(patient.phone);
    setInsurancePlan(patient.insurancePlan);
    setMemberId(patient.memberId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient?.id, ready]);

  if (!ready) return <p className="muted">Loading…</p>;
  if (!patient) {
    return (
      <section>
        <h1>Patient not found</h1>
        <Link href="/appointments" className="btn" data-testid="back-to-appointments">
          Back to appointments
        </Link>
      </section>
    );
  }

  const alreadyCheckedIn = patient.status !== "Scheduled";
  const missing: string[] = [];
  if (!phone.trim()) missing.push("phone");
  if (!insurancePlan) missing.push("insurance");
  if (insurancePlan && insurancePlan !== "Self-pay" && !memberId.trim()) missing.push("member ID");
  if (!idVerified) missing.push("ID verification");
  if (!consentSigned) missing.push("signed consent");
  if (!visitReason) missing.push("visit reason");
  if (!room) missing.push("room");
  const canComplete = missing.length === 0 && !alreadyCheckedIn;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!canComplete || !patient) return;
    const roomNumber = Number(room);
    dispatch({ type: "checkIn", id: patient.id, phone, insurancePlan, memberId, visitReason, room: roomNumber });
    notify(`Checked in · Waiting – Room ${roomNumber}`);
    router.push("/appointments");
  }

  return (
    <section>
      <div className="breadcrumbs">
        <Link href="/appointments" data-testid="breadcrumb-appointments">
          Today&apos;s Appointments
        </Link>
        <span aria-hidden="true"> / </span>
        <span>Check-In</span>
      </div>
      <h1>Patient Check-In</h1>
      <PatientHeader patient={patient} />

      {alreadyCheckedIn && (
        <div className="callout" data-testid="already-checked-in">
          This patient is already checked in ({patient.status}).
        </div>
      )}

      <form className="card form" onSubmit={onSubmit} noValidate data-testid="check-in-form">
        <fieldset>
          <legend>Contact</legend>
          <div className="field">
            <label htmlFor="phone">Confirm phone number</label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="check-in-phone"
              data-sensitive="phone"
            />
          </div>
        </fieldset>

        <fieldset>
          <legend>Insurance</legend>
          <div className="row">
            <div className="field">
              <label htmlFor="insurance">Insurance plan</label>
              <select
                id="insurance"
                value={insurancePlan}
                onChange={(e) => setInsurancePlan(e.target.value)}
                data-testid="check-in-insurance"
              >
                <option value="">Select a plan…</option>
                {INSURANCE_PLANS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="member-id">Member ID</label>
              <input
                id="member-id"
                type="text"
                autoComplete="off"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                disabled={insurancePlan === "Self-pay"}
                data-testid="check-in-member-id"
                data-sensitive="member-id"
              />
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Verification</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={idVerified}
              onChange={(e) => setIdVerified(e.target.checked)}
              data-testid="check-in-id-verified"
            />
            ID verified
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={consentSigned}
              onChange={(e) => setConsentSigned(e.target.checked)}
              data-testid="check-in-consent-signed"
            />
            Consent signed
          </label>
        </fieldset>

        <fieldset>
          <legend>Visit</legend>
          <div className="row">
            <div className="field">
              <label htmlFor="visit-reason">Visit reason</label>
              <select
                id="visit-reason"
                value={visitReason}
                onChange={(e) => setVisitReason(e.target.value)}
                data-testid="check-in-visit-reason"
              >
                <option value="">Select a reason…</option>
                {VISIT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="room">Room assignment</label>
              <select id="room" value={room} onChange={(e) => setRoom(e.target.value)} data-testid="check-in-room">
                <option value="">Select a room…</option>
                {ROOMS.map((r) => (
                  <option key={r} value={String(r)}>
                    Room {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        {submitted && missing.length > 0 && !alreadyCheckedIn && (
          <p className="error" role="alert" data-testid="check-in-missing">
            Still needed: {missing.join(", ")}.
          </p>
        )}

        <div className="actions">
          <Link href="/appointments" className="btn ghost" data-testid="check-in-cancel">
            Cancel
          </Link>
          <button type="submit" className="btn primary" data-testid="check-in-complete" disabled={alreadyCheckedIn}>
            Complete check-in
          </button>
        </div>
      </form>
    </section>
  );
}
