"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatDob, fullName, useStore } from "@/lib/store.tsx";

export default function AppointmentsPage() {
  const { patients } = useStore();
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...patients].sort((a, b) => a.appointmentTime.localeCompare(b.appointmentTime));
    if (!q) return sorted;
    return sorted.filter(
      (p) => fullName(p).toLowerCase().includes(q) || p.mrn.toLowerCase().includes(q) || p.provider.toLowerCase().includes(q),
    );
  }, [patients, query]);

  const waiting = patients.filter((p) => p.status !== "Scheduled").length;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Today&apos;s Appointments</h1>
          <p className="muted">
            {patients.length} scheduled · {waiting} checked in
          </p>
        </div>
        <div className="search">
          <label htmlFor="appt-search" className="visually-hidden">
            Search appointments
          </label>
          <input
            id="appt-search"
            type="search"
            placeholder="Search by name, MRN or provider"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="appointments-search"
            autoComplete="off"
          />
        </div>
      </div>

      <table className="table" data-testid="appointments-table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Patient</th>
            <th scope="col">DOB</th>
            <th scope="col">MRN</th>
            <th scope="col">Provider</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="visually-hidden">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const checkedIn = p.status !== "Scheduled";
            return (
              <tr key={p.id} data-testid={`appointment-row-${p.id}`}>
                <td className="mono">{p.appointmentTime}</td>
                <td>
                  <span data-sensitive="name">{fullName(p)}</span>
                </td>
                <td>
                  <span data-sensitive="dob">{formatDob(p.dob)}</span>
                </td>
                <td>
                  <span className="mono" data-sensitive="mrn">
                    {p.mrn}
                  </span>
                </td>
                <td>{p.provider}</td>
                <td>
                  <span className={checkedIn ? "chip waiting" : "chip"} data-testid={`appointment-status-${p.id}`}>
                    {p.status}
                  </span>
                </td>
                <td className="right">
                  {checkedIn ? (
                    <span className="muted small">Checked in</span>
                  ) : (
                    <Link
                      href={`/check-in/${p.id}`}
                      className="btn small"
                      data-testid={`check-in-${p.id}`}
                    >
                      Check in
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="empty" data-testid="appointments-empty">
                No appointments match “{query}”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
