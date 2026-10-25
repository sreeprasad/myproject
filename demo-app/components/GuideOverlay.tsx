"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { findTarget, isFinished, spotlightElement, stepPath } from "showme-recorder";
import { useGuide } from "@/lib/guide/GuideProvider.tsx";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 6;
const CARD_W = 320;

// Spotlight + pulsing ring + hint card. Purely visual: pointer-events pass through to the real page, so the
// learner clicks the actual element. Everything here is inside [data-showme-ignore].
export function GuideOverlay() {
  const { active, state, step, nudge, reportTargetMissing, doc, restart, exit } = useGuide();
  const pathname = usePathname();
  const router = useRouter();
  const [box, setBox] = useState<Box | null>(null);
  const [found, setFound] = useState(false);
  const scrolledFor = useRef<number | null>(null);

  const expectedPath = step ? stepPath(step) : null;
  const onRightPage = !step || !expectedPath || expectedPath === pathname;

  useLayoutEffect(() => {
    if (!active || !step || !onRightPage) {
      setBox(null);
      reportTargetMissing(false);
      return;
    }
    let raf = 0;
    const measure = () => {
      const el = findTarget(document, step.target?.identifiers);
      if (el) {
        const spot = spotlightElement(el);
        const r = spot.getBoundingClientRect();
        setBox({ x: r.left, y: r.top, w: r.width, h: r.height });
        setFound(true);
        reportTargetMissing(false);
        if (scrolledFor.current !== step.number) {
          scrolledFor.current = step.number;
          if (r.top < 70 || r.bottom > window.innerHeight - 20) spot.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      } else {
        const b = step.target?.bbox;
        setBox(b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null); // recorded position as a best guess
        setFound(false);
        reportTargetMissing(true);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const tick = window.setInterval(schedule, 400);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.clearInterval(tick);
    };
  }, [active, step, onRightPage, reportTargetMissing]);

  if (!active || !state) return null;

  const total = state.steps.length;

  if (isFinished(state)) {
    const secs = Math.round((Math.max(...Object.values(state.done).map((d) => d.at)) - state.startedAt) / 1000);
    const byClef = Object.values(state.done).filter((d) => d.by === "clef").length;
    return (
      <div className="guide-layer" data-showme-ignore="">
        <div className="guide-dim" />
        <div className="guide-card guide-card-center" role="dialog" aria-label="Guide complete">
          <div className="guide-kicker">All {total} steps done</div>
          <div className="guide-title">{doc?.workflow.title ?? "Workflow complete"}</div>
          <p className="guide-hint">
            Finished in {secs}s · {total - byClef} confirmed by your clicks{byClef ? `, ${byClef} by Clef` : ""}.
          </p>
          <div className="guide-actions">
            <button type="button" className="btn small" onClick={restart}>
              Practice again
            </button>
            <button type="button" className="btn small primary" onClick={exit}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!step) return null;

  if (!onRightPage) {
    const where = step.before_state?.headings?.[0] ?? expectedPath;
    return (
      <div className="guide-layer" data-showme-ignore="">
        <div className="guide-card guide-card-center">
          <div className="guide-kicker">
            Step {step.number} of {total}
          </div>
          <div className="guide-title">{step.title ?? "Next step"}</div>
          <p className="guide-hint">This step happens on “{where}”.</p>
          <div className="guide-actions">
            <button type="button" className="btn small primary" onClick={() => expectedPath && router.push(expectedPath)}>
              Take me there
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Card below the target if it fits, otherwise above; clamped to the viewport.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  let cardTop = 0;
  let cardLeft = 16;
  if (box) {
    const below = box.y + box.h + PAD + 14;
    cardTop = below + 150 < vh ? below : Math.max(12, box.y - PAD - 14 - 150);
    cardLeft = Math.min(Math.max(12, box.x), vw - CARD_W - 12);
  }

  return (
    <div className="guide-layer" data-showme-ignore="">
      {box ? (
        <div
          className={`guide-spot${found ? "" : " guide-spot-guess"}${nudge ? " guide-spot-nudge" : ""}`}
          style={{ left: box.x - PAD, top: box.y - PAD, width: box.w + PAD * 2, height: box.h + PAD * 2 }}
        />
      ) : (
        <div className="guide-dim" />
      )}
      <div
        className={`guide-card${nudge ? " guide-card-nudge" : ""}`}
        style={box ? { top: cardTop, left: cardLeft, width: CARD_W } : undefined}
        role="status"
        aria-live="polite"
      >
        <div className="guide-kicker">
          Step {step.number} of {total}
        </div>
        <div className="guide-title">{step.title ?? "Next step"}</div>
        {nudge === "wrong" && <div className="guide-nudge">Not quite. Look for the highlighted spot.</div>}
        {nudge === "idle" && <div className="guide-nudge">Need a hand? Here’s what to do:</div>}
        <p className="guide-hint">{step.narration}</p>
        {!found && <p className="guide-faint">Couldn’t find the exact element on this page; showing where it was.</p>}
      </div>
    </div>
  );
}
