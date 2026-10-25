import { formatDob, fullName } from "@/lib/store.tsx";
import type { Patient } from "@/lib/types.ts";

// Identity fields carry data-sensitive so the ShowMe recorder masks/blurs them.
// Never put patient identifiers in aria-labels or titles: the recorder reads accessible names.
export function PatientHeader({ patient }: { patient: Patient }) {
  return (
    <div className="patient-header" data-testid="patient-header">
      <div className="avatar" aria-hidden="true">
        {patient.firstName[0]}
        {patient.lastName[0]}
      </div>
      <div>
        <div className="patient-name" data-sensitive="name">
          {fullName(patient)}
        </div>
        <div className="patient-meta">
          <span>
            DOB <span data-sensitive="dob">{formatDob(patient.dob)}</span>
          </span>
          <span>
            MRN{" "}
            <span className="mono" data-sensitive="mrn">
              {patient.mrn}
            </span>
          </span>
          <span>{patient.provider}</span>
          <span>Appt {patient.appointmentTime}</span>
        </div>
      </div>
    </div>
  );
}
