// All data in this app is invented. Never put real patient information here.

export type AppointmentStatus = "Scheduled" | `Waiting – Room ${number}`;

export interface VitalsEntry {
  recordedAt: string; // ISO timestamp
  systolic: number;
  diastolic: number;
  heartRate: number;
  temperatureF: number;
  spo2: number;
  pain: number; // 0–10
}

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dob: string; // YYYY-MM-DD
  mrn: string;
  phone: string;
  insurancePlan: string;
  memberId: string;
  appointmentTime: string; // "08:30"
  provider: string;
  status: AppointmentStatus;
  visitReason?: string;
  vitals: VitalsEntry[];
}
