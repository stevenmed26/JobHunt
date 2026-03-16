// src/DraftCard.tsx — collapsible card for a single application draft

import { useState } from "react";
import { ScrapedFieldRow } from "./FieldRows";
import type { ApplicationDraft, ApplicantProfile } from "./types";

const ATS_COLOR: Record<string, string> = {
  greenhouse: "#1D9E75",
  lever:      "#0A84FF",
  unknown:    "rgba(255,255,255,0.3)",
};

const STATUS_LABEL: Record<ApplicationDraft["status"], string> = {
  pending:   "Pending",
  scraping:  "Scraping…",
  scraped:   "Review fields",
  filling:   "Filling…",
  ready:     "Ready",
  submitted: "Submitted",
  error:     "Error",
};

const STATUS_COLOR: Record<ApplicationDraft["status"], string> = {
  pending:   "rgba(255,255,255,0.4)",
  scraping:  "rgba(253,200,0,0.9)",
  scraped:   "rgba(10,132,255,0.9)",
  filling:   "rgba(253,200,0,0.9)",
  ready:     "rgba(30,215,96,0.9)",
  submitted: "rgba(30,215,96,0.5)",
  error:     "rgba(255,69,58,0.9)",
};

const STEPS = ["1  Scrape form", "2  Review & fill", "3  Open & submit"] as const;

function stepState(draft: ApplicationDraft, i: number): "done" | "active" | "idle" {
  if (i === 0) {
    if (["scraped", "filling", "ready", "submitted"].includes(draft.status)) return "done";
    if (draft.status === "scraping") return "active";
  }
  if (i === 1) {
    if (["ready", "submitted"].includes(draft.status)) return "done";
    if (draft.status === "scraped" || draft.status === "filling") return "active";
  }
  if (i === 2) {
    if (draft.status === "submitted") return "done";
    if (draft.applying) return "active";
  }
  return "idle";
}

export function DraftCard({
  draft,
  onScrape,
  onFill,
  onRemove,
  onScrapedFieldChange,
  onApply,
}: {
  draft: ApplicationDraft;
  profile: ApplicantProfile; // kept for future per-card profile overrides
  onScrape: () => void;
  onFill: () => void;
  onRemove: () => void;
  onScrapedFieldChange: (idx: number, val: string) => void;
  onApply: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const hasScraped  = draft.scrapedFields.length > 0;
  const displayFields = hasScraped ? draft.scrapedFields : null;
  const filledCount   = displayFields
    ? displayFields.filter((f) => f.type !== "file" && f.value?.trim()).length
    : draft.fields.filter((f) => f.value.trim()).length;
  const totalCount    = displayFields
    ? displayFields.filter((f) => f.type !== "file").length
    : draft.fields.length;
  const pct = totalCount > 0 ? Math.round((filledCount / totalCount) * 100) : 0;

  const isWorking = draft.status === "scraping" || draft.status === "filling" || !!draft.applying;
  const canApply  = draft.status === "scraped" || draft.status === "ready";

  return (
    <div style={{
      borderBottom: "1px solid rgba(255,255,255,0.07)",
      background: expanded ? "rgba(255,255,255,0.025)" : "transparent",
      transition: "background 150ms ease",
    }}>

      {/* ── Header ── */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}
        onClick={() => setExpanded((x) => !x)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((x) => !x)}
      >
        <span style={{
          fontSize: 10, padding: "2px 7px", borderRadius: 999, flexShrink: 0,
          background: ATS_COLOR[draft.atsType], color: "white", fontWeight: 600,
          letterSpacing: "0.04em", textTransform: "uppercase",
        }}>
          {draft.atsType}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {draft.title}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
            {draft.company}
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ width: 60, flexShrink: 0 }}>
          <div style={{ height: 3, borderRadius: 999, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${pct}%`, borderRadius: 999, transition: "width 300ms ease",
              background: pct === 100 ? "rgba(30,215,96,0.8)" : "rgba(253,72,37,0.7)",
            }} />
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 3, textAlign: "right" }}>
            {filledCount}/{totalCount}
          </div>
        </div>

        <span style={{
          fontSize: 11, color: STATUS_COLOR[draft.status], minWidth: 80, textAlign: "right", flexShrink: 0,
        }}>
          {STATUS_LABEL[draft.status]}
        </span>

        <span style={{
          fontSize: 11, color: "rgba(255,255,255,0.3)", flexShrink: 0,
          transform: expanded ? "rotate(90deg)" : "none", transition: "transform 150ms ease",
        }}>›</span>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div>
          {draft.status === "error" && draft.errorMsg && (
            <div className="atsWarning" style={{ margin: "0 14px 10px" }}>{draft.errorMsg}</div>
          )}

          {/* Step indicator */}
          <div style={{
            display: "flex", margin: "0 14px 12px", borderRadius: 10,
            overflow: "hidden", border: "1px solid rgba(255,255,255,0.08)",
          }}>
            {STEPS.map((label, i) => {
              const s = stepState(draft, i);
              return (
                <div key={i} style={{
                  flex: 1, padding: "6px 10px", fontSize: 11, textAlign: "center",
                  background: s === "done" ? "rgba(30,215,96,0.12)" : s === "active" ? "rgba(10,132,255,0.12)" : "rgba(255,255,255,0.02)",
                  color:      s === "done" ? "rgba(30,215,96,0.9)"  : s === "active" ? "rgba(10,132,255,0.9)"  : "rgba(255,255,255,0.3)",
                  borderRight: i < 2 ? "1px solid rgba(255,255,255,0.08)" : "none",
                }}>
                  {s === "done" ? "✓ " : ""}{label}
                </div>
              );
            })}
          </div>

          {/* Fields panel */}
          <div style={{
            margin: "0 14px", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14, overflow: "hidden", background: "rgba(255,255,255,0.03)",
          }}>
            {hasScraped ? (
              <>
                <div style={{
                  padding: "8px 14px", fontSize: 11, color: "rgba(255,255,255,0.4)",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}>
                  {draft.scrapedFields.length} fields scraped — edit any value before submitting
                </div>
                {draft.scrapedFields.map((f, i) => (
                  <ScrapedFieldRow key={i} field={f} idx={i} onChange={onScrapedFieldChange} />
                ))}
              </>
            ) : draft.status === "scraping" ? (
              <div style={{ padding: 16, fontSize: 12, color: "rgba(253,200,0,0.8)" }}>
                Opening form in headless browser and reading all fields…
              </div>
            ) : (
              <div style={{ padding: 16, fontSize: 12, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>
                <strong style={{ color: "rgba(255,255,255,0.7)", display: "block", marginBottom: 4 }}>
                  Step 1: Scrape the form
                </strong>
                Click <strong>Scrape Form</strong> — Playwright opens the job URL, reads every
                field and dropdown, then Groq fills them using your profile. You review before
                anything is submitted.
              </div>
            )}
          </div>

          {/* Action row */}
          <div style={{
            display: "flex", gap: 8, padding: "10px 14px 14px",
            alignItems: "center", flexWrap: "wrap",
          }}>
            <button
              className="btn btnPrimary"
              style={{ fontSize: 12, padding: "7px 14px" }}
              onClick={(e) => { e.stopPropagation(); onScrape(); }}
              disabled={isWorking}
            >
              {draft.status === "scraping" ? "Scraping…" : hasScraped ? "Re-scrape form" : "Scrape form"}
            </button>

            {hasScraped && (
              <button
                className="btn"
                style={{ fontSize: 12, padding: "7px 14px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}
                onClick={(e) => { e.stopPropagation(); onFill(); }}
                disabled={isWorking}
              >
                {draft.status === "filling" ? "Filling…" : "Re-fill with Groq"}
              </button>
            )}

            {canApply && (
              <button
                className="btn"
                style={{
                  fontSize: 12, padding: "7px 14px",
                  background: draft.applying ? "rgba(255,255,255,0.06)" : draft.status === "submitted" ? "rgba(30,215,96,0.15)" : "rgba(30,215,96,0.22)",
                  border: `1px solid ${draft.status === "submitted" ? "rgba(30,215,96,0.3)" : "rgba(30,215,96,0.5)"}`,
                  color: draft.status === "submitted" ? "rgba(30,215,96,0.6)" : "rgba(30,215,96,1)",
                  cursor: draft.applying || draft.status === "submitted" ? "default" : "pointer",
                }}
                onClick={(e) => { e.stopPropagation(); if (!draft.applying && draft.status !== "submitted") onApply(); }}
                disabled={!!draft.applying || draft.status === "submitted"}
              >
                {draft.applying ? "Launching…" : draft.status === "submitted" ? "✓ Launched" : "Open & Fill Browser"}
              </button>
            )}

            <a
              className="btn"
              style={{ fontSize: 12, padding: "7px 14px", textDecoration: "none" }}
              href={draft.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              Open job ↗
            </a>

            <div style={{ flex: 1 }} />

            <button
              className="btn"
              style={{ fontSize: 12, padding: "7px 10px", opacity: 0.5 }}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}