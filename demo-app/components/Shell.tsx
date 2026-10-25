"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/lib/store.tsx";
import { GuideProvider, useGuide } from "@/lib/guide/GuideProvider.tsx";
import { GuideOverlay } from "./GuideOverlay.tsx";
import { GuidePanel } from "./GuidePanel.tsx";
import { RecorderPanel } from "./RecorderPanel.tsx";

const NAV = [
  { href: "/appointments", label: "Today's Appointments", testid: "nav-appointments" },
  { href: "/patients", label: "My Patients", testid: "nav-patients" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <GuideProvider>
      <ShellInner>{children}</ShellInner>
    </GuideProvider>
  );
}

// Recording and guiding never run together: the guide replaces the recorder pill while active.
function ShowMeLayer() {
  const { active } = useGuide();
  return active ? (
    <>
      <GuideOverlay />
      <GuidePanel />
    </>
  ) : (
    <RecorderPanel />
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { dispatch, notify, toasts } = useStore();

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✚</span>
          <span className="brand-name">LumenCare</span>
          <span className="brand-site">Lumen General Hospital · Front Desk</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              data-testid={n.testid}
              className={pathname.startsWith(n.href) ? "nav-link active" : "nav-link"}
              aria-current={pathname.startsWith(n.href) ? "page" : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <button
          type="button"
          className="btn ghost small"
          data-testid="reset-demo-data"
          onClick={() => {
            dispatch({ type: "reset" });
            notify("Demo data reset");
          }}
        >
          Reset demo data
        </button>
      </header>
      <div className="demo-banner" role="note">
        Fictional demo system. All patients and data are invented.
      </div>
      <main className="content">{children}</main>
      <ShowMeLayer />
      <div className="toasts" role="status" aria-live="polite" data-testid="toast-region">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-testid="toast">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
