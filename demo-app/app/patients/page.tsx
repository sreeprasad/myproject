"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDob, fullName, useStore } from "@/lib/store.tsx";

export default function MyPatientsPage() {
  const { patients } = useStore();
  const [onlyCheckedIn, setOnlyCheckedIn] = useState(false);

  const list = [...patients]
    .sort((a, b) => a.appointmentTime.localeCompare(b.appointmentTime))
    .filter((p) => !onlyCheckedIn || p.status !== "Scheduled");

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>My Patients</h1>
          <p className="muted">Select a patient to record vitals.</p>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyCheckedIn}
            onChange={(e) => setOnlyCheckedIn(e.target.checked)}
            data-testid="patients-only-checked-in"
          />
          Checked-in only
        </label>
      </div>

      <ul className="patient-grid" data-testid="patients-list">
        {list.map((p) => {
          const last = p.vitals[0];
          return (
            <li key={p.id} className="card patient-card" data-testid={`patient-card-${p.id}`}>
              <div className="patient-card-top">
                <div>
                  <div className="patient-name small-name" data-sensitive="name">
                    {fullName(p)}
                  </div>
                  <div className="muted small">
                    DOB <span data-sensitive="dob">{formatDob(p.dob)}</span> · MRN{" "}
                    <span className="mono" data-sensitive="mrn">
                      {p.mrn}
                    </span>
                  </div>
                </div>
                <span className={p.status === "Scheduled" ? "chip" : "chip waiting"}>{p.status}</span>
              </div>
              <div className="muted small">
                {last ? `Last vitals ${new Date(last.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "No vitals today"}
              </div>
              <Link href={`/patients/${p.id}/vitals`} className="btn small" data-testid={`record-vitals-${p.id}`}>
                Record vitals
              </Link>
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="empty" data-testid="patients-empty">
            No checked-in patients yet.
          </li>
        )}
      </ul>
    </section>
  );
}
