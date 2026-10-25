"use client";

import { useGuide } from "@/lib/guide/GuideProvider.tsx";

function Bar({ label, value, threshold, tone }: { label: string; value: number; threshold?: number; tone: "blue" | "amber" | "gray" }) {
  const pct = Math.round(value * 100);
  return (
    <div className="gp-bar">
      <div className="gp-bar-label">
        <span>{label}</span>
        <span className="mono">{pct}%</span>
      </div>
      <div className="gp-bar-track">
        <div className={`gp-bar-fill gp-${tone}`} style={{ width: `${pct}%` }} />
        {threshold != null && <div className="gp-bar-mark" style={{ left: `${threshold * 100}%` }} title={`threshold ${threshold}`} />}
      </div>
    </div>
  );
}

// Checklist + Clef probabilities + blur toggle. Inside [data-showme-ignore] so clicks here never count.
export function GuidePanel() {
  const { state, doc, step, clef, clefBusy, blur, setBlur, exit, error } = useGuide();
  if (!state) return null;
  const total = state.steps.length;
  const doneCount = Object.keys(state.done).length;

  const cs = clef?.answers.current_step;
  const top = cs
    ? Object.entries(cs.probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1)[0]
    : null;
  const topLabel = top ? (top[0] === "off_track" ? "off track" : top[0].replace("step_", "step ")) : null;

  return (
    <div className="guide-panel" data-showme-ignore="" aria-label="ShowMe guide">
      <div className="gp-head">
        <div>
          <div className="gp-kicker">ShowMe guide</div>
          <div className="gp-title">{doc?.workflow.title ?? "Workflow"}</div>
        </div>
        <button type="button" className="rec-btn" onClick={exit}>
          Exit
        </button>
      </div>
      <div className="gp-progress" aria-label={`${doneCount} of ${total} steps done`}>
        <div style={{ width: `${(doneCount / total) * 100}%` }} />
      </div>
      <ol className="gp-steps">
        {state.steps.map((s) => {
          const d = state.done[s.number];
          const isCur = step?.number === s.number;
          return (
            <li key={s.number} className={d ? "done" : isCur ? "current" : ""}>
              <span className="gp-num">{d ? "✓" : s.number}</span>
              <span className="gp-text">{s.title ?? s.action}</span>
              {d && <span className={`gp-by gp-by-${d.by}`}>{d.by === "clef" ? "Clef" : "click"}</span>}
            </li>
          );
        })}
      </ol>
      <div className="gp-clef">
        <div className="gp-clef-head">
          <span>Clef</span>
          <span className="gp-faint">
            {clefBusy ? "checking…" : clef ? `${clef.model} · ${Math.round(clef.latency_ms)} ms · ${clef.trigger.replace("_", " ")}` : "asked only when clicks aren’t conclusive"}
          </span>
        </div>
        {clef && (
          <>
            <Bar label={`Step ${clef.step_number} done`} value={clef.answers.step_done.noul} threshold={clef.thresholds.step_done} tone="blue" />
            <Bar label="Stuck" value={clef.answers.stuck.noul} threshold={clef.thresholds.stuck} tone="amber" />
            {top && <Bar label={`Learner is on: ${topLabel}`} value={top[1]} tone="gray" />}
          </>
        )}
      </div>
      {error && <div className="gp-error">{error}</div>}
      <label className="gp-toggle">
        <input type="checkbox" checked={blur} onChange={(e) => setBlur(e.target.checked)} />
        Blur patient details
      </label>
    </div>
  );
}
