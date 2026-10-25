"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { seedPatients } from "./seed.ts";
import type { Patient, VitalsEntry } from "./types.ts";

const STORAGE_KEY = "lumencare-demo-v1";

type Action =
  | { type: "load"; patients: Patient[] }
  | { type: "reset" }
  | {
      type: "checkIn";
      id: string;
      phone: string;
      insurancePlan: string;
      memberId: string;
      visitReason: string;
      room: number;
    }
  | { type: "addVitals"; id: string; entry: VitalsEntry };

function reducer(state: Patient[], action: Action): Patient[] {
  switch (action.type) {
    case "load":
      return action.patients;
    case "reset":
      return seedPatients();
    case "checkIn":
      return state.map((p) =>
        p.id === action.id
          ? {
              ...p,
              phone: action.phone,
              insurancePlan: action.insurancePlan,
              memberId: action.memberId,
              visitReason: action.visitReason,
              status: `Waiting – Room ${action.room}`,
            }
          : p,
      );
    case "addVitals":
      return state.map((p) => (p.id === action.id ? { ...p, vitals: [action.entry, ...p.vitals] } : p));
  }
}

interface Toast {
  id: number;
  text: string;
}

interface StoreValue {
  patients: Patient[];
  ready: boolean;
  dispatch: (a: Action) => void;
  toasts: Toast[];
  notify: (text: string) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [patients, dispatch] = useReducer(reducer, undefined, seedPatients);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  // Load persisted demo state after mount (localStorage may be unavailable; the app still works without it).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Patient[];
        if (Array.isArray(parsed) && parsed.length > 0) dispatch({ type: "load", patients: parsed });
      }
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(patients));
    } catch {
      /* ignore */
    }
  }, [patients, ready]);

  const notify = useCallback((text: string) => {
    const id = nextToast.current++;
    setToasts((t) => [...t, { id, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const value = useMemo(() => ({ patients, ready, dispatch, toasts, notify }), [patients, ready, toasts, notify]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error("useStore must be used inside StoreProvider");
  return v;
}

export function fullName(p: Patient): string {
  return `${p.firstName} ${p.lastName}`;
}

export function formatDob(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}
