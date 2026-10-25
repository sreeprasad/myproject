// INVENTED demo data for the fictional "Lumen General Hospital".
// Names, DOBs, MRNs, phone numbers (555-01xx is reserved for fiction) and plans are all made up.
import type { Patient } from "./types.ts";

export const INSURANCE_PLANS = [
  "Blue Harbor PPO",
  "Cedar Valley HMO",
  "Northwind Health Basic",
  "Summit Mutual EPO",
  "Lantern Care Medicare Advantage",
  "Self-pay",
] as const;

export const VISIT_REASONS = [
  "Annual physical",
  "Follow-up visit",
  "New symptom",
  "Medication review",
  "Lab results review",
  "Vaccination",
] as const;

export const ROOMS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const PROVIDERS = ["Dr. Imani Okafor", "Dr. Theo Lindqvist", "Dr. Priya Raman"] as const;

type SeedRow = [string, string, string, string, string, number, string];
// [first, last, dob, appointmentTime, insurance plan, provider index, member id]
const ROWS: SeedRow[] = [
  ["Marisol", "Quintero", "1984-03-12", "08:00", "Blue Harbor PPO", 0, "BHP-48213907"],
  ["Desmond", "Achterberg", "1957-11-02", "08:15", "Lantern Care Medicare Advantage", 1, "LCM-20934411"],
  ["Junie", "Halvorsen", "1992-07-25", "08:30", "Cedar Valley HMO", 2, "CVH-77120345"],
  ["Rafferty", "Osei", "1979-01-18", "08:45", "Northwind Health Basic", 0, "NHB-33019852"],
  ["Calla", "Brightwater", "2001-09-09", "09:00", "Summit Mutual EPO", 1, "SME-90217736"],
  ["Ignatius", "Pell", "1948-05-30", "09:15", "Lantern Care Medicare Advantage", 2, "LCM-11487203"],
  ["Noor", "Saffari", "1988-12-04", "09:30", "Blue Harbor PPO", 0, "BHP-56032198"],
  ["Tobiah", "Wrenfield", "1995-02-14", "09:45", "Self-pay", 1, "SELF-0000"],
  ["Esperanza", "Valcourt", "1971-08-21", "10:00", "Cedar Valley HMO", 2, "CVH-61409927"],
  ["Linus", "Marrowby", "1966-04-07", "10:15", "Northwind Health Basic", 0, "NHB-84720061"],
  ["Ottilie", "Fenwick", "1999-10-31", "10:30", "Summit Mutual EPO", 1, "SME-15398274"],
  ["Kwame", "Delacroix-Ansah", "1983-06-16", "10:45", "Blue Harbor PPO", 2, "BHP-72905513"],
  ["Saoirse", "Lindqvist-Moore", "1990-01-03", "11:00", "Cedar Valley HMO", 0, "CVH-30871649"],
  ["Bartholomew", "Ng", "1952-09-27", "11:15", "Lantern Care Medicare Advantage", 1, "LCM-98321470"],
  ["Ines", "Corvalán", "1986-03-29", "13:00", "Northwind Health Basic", 2, "NHB-41129087"],
  ["Thaddeus", "Okonkwo-Reyes", "1975-12-12", "13:15", "Blue Harbor PPO", 0, "BHP-60713382"],
  ["Wren", "Abernathy", "2003-05-05", "13:30", "Summit Mutual EPO", 1, "SME-27640195"],
  ["Matthias", "Szabo", "1961-07-19", "13:45", "Cedar Valley HMO", 2, "CVH-88452013"],
  ["Pilar", "Eastwick", "1997-11-23", "14:00", "Blue Harbor PPO", 0, "BHP-19284756"],
  ["Augustin", "Vey", "1944-02-08", "14:15", "Lantern Care Medicare Advantage", 1, "LCM-50267318"],
];

export function seedPatients(): Patient[] {
  return ROWS.map(([firstName, lastName, dob, appointmentTime, insurancePlan, p, memberId], i) => {
    const n = i + 1;
    return {
      id: `p${String(n).padStart(2, "0")}`,
      firstName,
      lastName,
      dob,
      mrn: `LG-${String(104200 + n * 37).padStart(6, "0")}`,
      phone: `(408) 555-01${String(n).padStart(2, "0")}`,
      insurancePlan,
      memberId,
      appointmentTime,
      provider: PROVIDERS[p],
      status: "Scheduled",
      vitals: [],
    };
  });
}
